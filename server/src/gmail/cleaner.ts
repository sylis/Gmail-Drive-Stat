import { CleanupEngine, failureCode, isFatal, type BrickRow, type Cleanup, type Target, type WorkItem } from '../cleanup.js';
import { NotFoundError, type GmailApi, type GoogleGateway, type GoogleTokens } from '../google.js';
import type { Store } from '../store.js';
import { drain, type Pacer, type ThrottleOptions } from '../throttle.js';
import type { GmailStore } from './store.js';

/** Actions de nettoyage ; seules la corbeille et la suppression libèrent de la place. */
export const ACTIONS = ['trash', 'delete', 'archive', 'read', 'unread', 'untrash'] as const;
export type CleanupAction = (typeof ACTIONS)[number];

// Coût en unités de quota des appels utilisés (documentation Gmail).
const COST = { trash: 5, untrash: 5, delete: 10, batch: 50 };
/** Nombre de messages par appel groupé (Gmail en accepte jusqu'à 1000). */
const BATCH_IDS = 500;
const CHUNK = 300;

const LABEL_CHANGES: Record<'archive' | 'read' | 'unread', { add?: string[]; remove?: string[] }> = {
  archive: { remove: ['INBOX'] },
  read: { remove: ['UNREAD'] },
  unread: { add: ['UNREAD'] },
};

/** Nettoyage de Gmail : une brique visée est l'ensemble des messages d'une conversation dans une zone. */
export class GmailCleaner extends CleanupEngine {
  protected readonly tables = { jobs: 'gmail_cleanups', items: 'gmail_cleanup_items' };
  readonly #gmail: GmailStore;

  constructor(store: Store, gmail: GmailStore, google: GoogleGateway | null, options: ThrottleOptions = {}) {
    super(store, gmail, google, options);
    this.#gmail = gmail;
  }

  protected *bricks(accountId: number, targets: Target[]): Iterable<BrickRow> {
    for (const zone of ['inbox', 'sent', 'trash']) {
      const ids = [...new Set(targets.filter((target) => target.zone === zone).map((target) => target.id))];
      for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK);
        yield* this.#gmail
          .q(
            `SELECT thread_id AS id, zone, subject, domain, size, msgs, flagged FROM gmail_bricks
             WHERE account_id = ? AND zone = ? AND thread_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(accountId, zone, ...chunk) as unknown as BrickRow[];
      }
    }
  }

  protected freeze(accountId: number, brick: BrickRow, action: string): { ids: string[]; restore: string[] } {
    const messages = this.#gmail
      .q('SELECT id, labels FROM gmail_messages WHERE account_id = ? AND thread_id = ? AND zone = ?')
      .all(accountId, brick.id, brick.zone) as { id: string; labels: string }[];
    // Pour pouvoir restaurer : la corbeille retire un message de la boîte de réception, on retient lesquels y étaient.
    const inInbox = messages.filter((message) => (JSON.parse(message.labels) as string[]).includes('INBOX'));
    return { ids: messages.map((message) => message.id), restore: action === 'trash' ? inInbox.map((message) => message.id) : [] };
  }

  protected async execute(cleanup: Cleanup, run: Pacer, tokens: GoogleTokens): Promise<void> {
    const { id, accountId, action } = cleanup;
    const api = this.google!.gmail(tokens, (fresh) => this.store.saveTokens(accountId, fresh));

    if (action === 'trash' || action === 'untrash') {
      await drain(4, () => this.pending(id, 200), (item) => this.#oneByOne(api, run, cleanup, item));
      return;
    }
    for (let items = this.pending(id, 200); items.length > 0; items = this.pending(id, 200)) {
      // Un appel groupé traite plusieurs conversations ; elles sont confirmées ou en échec ensemble.
      let batch: WorkItem[] = [];
      let size = 0;
      for (const item of items) {
        if (batch.length > 0 && size + item.ids.length > BATCH_IDS) {
          await this.#grouped(api, run, cleanup, batch);
          [batch, size] = [[], 0];
        }
        batch.push(item);
        size += item.ids.length;
      }
      await this.#grouped(api, run, cleanup, batch);
    }
  }

  /** Corbeille et restauration : Gmail les traite message par message. */
  async #oneByOne(api: GmailApi, run: Pacer, cleanup: Cleanup, item: WorkItem): Promise<void> {
    const { accountId, action } = cleanup;
    const done: string[] = [];
    const gone: string[] = [];
    let failure: string | null = null;
    try {
      for (const messageId of item.ids) {
        try {
          await this.throttle.call(run, COST[action === 'trash' ? 'trash' : 'untrash'], () =>
            action === 'trash' ? api.trashMessage(messageId) : api.untrashMessage(messageId),
          );
          done.push(messageId);
        } catch (error) {
          if (isFatal(error)) throw error;
          // Un message déjà disparu du compte n'est pas un échec : il n'y a plus rien à traiter.
          if (error instanceof NotFoundError) gone.push(messageId);
          else failure ??= failureCode(error);
        }
      }
      const back = action === 'untrash' ? done.filter((messageId) => item.restore.includes(messageId)) : [];
      if (back.length > 0) {
        try {
          await this.throttle.call(run, COST.batch, () => api.batchModify(back, { add: ['INBOX'] }));
        } catch (error) {
          if (isFatal(error)) throw error;
          back.length = 0;
          failure ??= failureCode(error);
        }
      }
      // La base suit ce que Gmail a confirmé, message par message, même si la conversation est en échec partiel.
      if (action === 'trash') this.#gmail.changeLabels(accountId, done, { add: ['TRASH'], remove: ['INBOX'] });
      else {
        this.#gmail.changeLabels(accountId, done, { remove: ['TRASH'] });
        this.#gmail.changeLabels(accountId, back, { add: ['INBOX'] });
      }
      this.#gmail.removeMessages(accountId, gone);
      this.settle(cleanup.id, item, failure);
    } catch (error) {
      // Arrêt en cours de conversation : ce qui est déjà fait chez Gmail est tout de même reporté en base.
      if (action === 'trash') this.#gmail.changeLabels(accountId, done, { add: ['TRASH'], remove: ['INBOX'] });
      else this.#gmail.changeLabels(accountId, done, { remove: ['TRASH'] });
      throw error;
    }
  }

  /** Suppression définitive, archivage, lu et non lu : un appel groupé pour plusieurs conversations. */
  async #grouped(api: GmailApi, run: Pacer, cleanup: Cleanup, items: WorkItem[]): Promise<void> {
    if (items.length === 0) return;
    const { accountId, action } = cleanup;
    const ids = items.flatMap((item) => item.ids);
    const apply = (messageIds: string[]) =>
      action === 'delete'
        ? this.#gmail.removeMessages(accountId, messageIds)
        : this.#gmail.changeLabels(accountId, messageIds, LABEL_CHANGES[action as keyof typeof LABEL_CHANGES]);
    try {
      await this.throttle.call(run, COST.batch, () =>
        action === 'delete' ? api.batchDelete(ids) : api.batchModify(ids, LABEL_CHANGES[action as keyof typeof LABEL_CHANGES]),
      );
      apply(ids);
      for (const item of items) this.settle(cleanup.id, item, null);
    } catch (error) {
      if (isFatal(error)) throw error;
      if (items.length === 1 && action !== 'delete') return this.settle(cleanup.id, items[0]!, failureCode(error));
      // Le lot a été refusé en bloc : on reprend conversation par conversation pour isoler celle qui pose problème.
      for (const item of items) {
        if (action === 'delete') await this.#deleteOneByOne(api, run, cleanup, item);
        else await this.#grouped(api, run, cleanup, [item]);
      }
    }
  }

  async #deleteOneByOne(api: GmailApi, run: Pacer, cleanup: Cleanup, item: WorkItem): Promise<void> {
    const removed: string[] = [];
    let failure: string | null = null;
    try {
      for (const messageId of item.ids) {
        try {
          await this.throttle.call(run, COST.delete, () => api.deleteMessage(messageId));
          removed.push(messageId);
        } catch (error) {
          if (isFatal(error)) throw error;
          if (error instanceof NotFoundError) removed.push(messageId);
          else failure ??= failureCode(error);
        }
      }
    } finally {
      this.#gmail.removeMessages(cleanup.accountId, removed);
    }
    this.settle(cleanup.id, item, failure);
  }
}

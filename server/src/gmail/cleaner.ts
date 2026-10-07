import { transaction } from '../db.js';
import {
  MissingScopeError,
  NotFoundError,
  ReauthRequiredError,
  RetryLaterError,
  type GmailApi,
  type GoogleGateway,
} from '../google.js';
import type { Store } from '../store.js';
import { drain, Stopped, Throttle, type Pacer, type ThrottleOptions } from '../throttle.js';
import type { Zone } from './parse.js';
import type { GmailStore } from './store.js';

/** Actions de nettoyage ; seules la corbeille et la suppression libèrent de la place. */
export const ACTIONS = ['trash', 'delete', 'archive', 'read', 'unread', 'untrash'] as const;
export type CleanupAction = (typeof ACTIONS)[number];
export type CleanupStatus = 'running' | 'auth' | 'done' | 'cancelled' | 'failed';
export type ItemState = 'pending' | 'done' | 'failed' | 'skipped';

/** Une brique visée : les messages d'une conversation situés dans une zone. */
export interface Target {
  id: string;
  zone: Zone;
}

export interface Cleanup {
  id: number;
  accountId: number;
  action: CleanupAction;
  simulate: boolean;
  status: CleanupStatus;
  error: string | null;
  /** Pour une restauration : la mise à la corbeille qu'elle annule. */
  sourceId: number | null;
  createdAt: number;
  finishedAt: number | null;
}

type Counts = Record<ItemState, { conversations: number; messages: number; size: number }>;
export interface CleanupProgress extends Cleanup {
  counts: Counts;
  retryAt: number | null;
  /** Une mise à la corbeille terminée peut être annulée tant qu'elle n'a pas déjà été restaurée. */
  restorable: boolean;
}

export interface CleanupItem {
  id: string;
  zone: Zone;
  subject: string;
  domain: string;
  size: number;
  msgs: number;
  state: ItemState;
  error: string | null;
}

export interface Preview {
  conversations: number;
  messages: number;
  size: number;
  /** Conversations contenant un message marqué important ou suivi. */
  flagged: number;
  top: { subject: string; size: number; msgs: number }[];
}

interface CleanupRow {
  id: number;
  account_id: number;
  action: CleanupAction;
  simulate: number;
  status: CleanupStatus;
  error: string | null;
  source_id: number | null;
  created_at: number;
  finished_at: number | null;
}

interface WorkItem {
  threadId: string;
  zone: Zone;
  ids: string[];
  restore: string[];
}

const toCleanup = (row: CleanupRow): Cleanup => ({
  id: row.id,
  accountId: row.account_id,
  action: row.action,
  simulate: row.simulate === 1,
  status: row.status,
  error: row.error,
  sourceId: row.source_id,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

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

/** Erreurs qui arrêtent tout le nettoyage ; les autres ne font échouer que la conversation en cours. */
const isFatal = (error: unknown) =>
  error instanceof Stopped || error instanceof ReauthRequiredError || error instanceof MissingScopeError || error instanceof RetryLaterError;

function reason(error: unknown): string {
  if (error instanceof NotFoundError) return 'introuvable';
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 403 ? 'refus' : status === 400 ? 'requete-refusee' : 'erreur-google';
}

interface Run extends Pacer {
  finished: Promise<void>;
}

/**
 * Exécute les nettoyages Gmail en tâche de fond.
 * Règle de sûreté : Gmail d'abord, la base ensuite. Une conversation n'est modifiée en base qu'une fois
 * l'opération confirmée par Gmail ; un échec la laisse en place et la signale.
 */
export class GmailCleaner {
  readonly #store: Store;
  readonly #gmail: GmailStore;
  readonly #google: GoogleGateway | null;
  readonly #throttle: Throttle;
  readonly #runs = new Map<number, Run>();
  log?: { warn: (details: object, message: string) => void };

  constructor(store: Store, gmail: GmailStore, google: GoogleGateway | null, options: ThrottleOptions = {}) {
    this.#store = store;
    this.#gmail = gmail;
    this.#google = google;
    this.#throttle = new Throttle(options);
  }

  // --- Préparation ---

  /** Ce que représente une sélection, d'après la base : c'est ce récapitulatif que l'utilisateur confirme. */
  preview(accountId: number, targets: Target[]): Preview {
    const preview: Preview = { conversations: 0, messages: 0, size: 0, flagged: 0, top: [] };
    for (const brick of this.#bricks(accountId, targets)) {
      preview.conversations++;
      preview.messages += brick.msgs;
      preview.size += brick.size;
      preview.flagged += brick.flagged;
      preview.top.push({ subject: brick.subject, size: brick.size, msgs: brick.msgs });
    }
    preview.top = preview.top.sort((a, b) => b.size - a.size).slice(0, 5);
    return preview;
  }

  *#bricks(accountId: number, targets: Target[]) {
    for (const zone of ['inbox', 'sent', 'trash'] as const) {
      const ids = [...new Set(targets.filter((target) => target.zone === zone).map((target) => target.id))];
      for (let start = 0; start < ids.length; start += CHUNK) {
        const chunk = ids.slice(start, start + CHUNK);
        yield* this.#gmail
          .q(
            `SELECT thread_id AS id, zone, subject, domain, size, msgs, flagged FROM gmail_bricks
             WHERE account_id = ? AND zone = ? AND thread_id IN (${chunk.map(() => '?').join(', ')})`,
          )
          .all(accountId, zone, ...chunk) as unknown as {
          id: string;
          zone: Zone;
          subject: string;
          domain: string;
          size: number;
          msgs: number;
          flagged: number;
        }[];
      }
    }
  }

  /** Vrai tant qu'un nettoyage tourne ou attend une reconnexion pour ce compte. */
  active(accountId: number): boolean {
    const latest = this.#latest(accountId);
    return latest !== null && (latest.status === 'running' || latest.status === 'auth');
  }

  /**
   * Enregistre un nettoyage et le lance. La liste des messages visés est figée ici, à partir de la base :
   * ce qui est exécuté est exactement ce qui a été récapitulé.
   */
  start(accountId: number, action: CleanupAction, targets: Target[], simulate: boolean): Cleanup | null {
    if (this.active(accountId)) return null;
    const cleanup = transaction(this.#gmail.db, () => {
      const id = this.#insert(accountId, action, simulate, null);
      for (const brick of this.#bricks(accountId, targets)) {
        const messages = this.#gmail
          .q('SELECT id, labels FROM gmail_messages WHERE account_id = ? AND thread_id = ? AND zone = ?')
          .all(accountId, brick.id, brick.zone) as { id: string; labels: string }[];
        // Pour pouvoir restaurer : la corbeille retire un message de la boîte de réception, on retient lesquels y étaient.
        const inInbox = messages.filter((message) => (JSON.parse(message.labels) as string[]).includes('INBOX'));
        this.#insertItem(id, brick, messages.map((message) => message.id), action === 'trash' ? inInbox.map((message) => message.id) : []);
      }
      return this.#get(id)!;
    });
    this.#launch(cleanup);
    return cleanup;
  }

  /** Annule une mise à la corbeille : sort de la corbeille ce qu'elle y avait mis. */
  restore(accountId: number, sourceId: number): Cleanup | null {
    const source = this.#get(sourceId);
    if (!source || source.accountId !== accountId || !this.#restorable(source) || this.active(accountId)) return null;
    const cleanup = transaction(this.#gmail.db, () => {
      const id = this.#insert(accountId, 'untrash', false, sourceId);
      this.#gmail
        .q(
          `INSERT INTO gmail_cleanup_items (cleanup_id, thread_id, zone, subject, domain, size, msgs, message_ids, restore, state)
           SELECT ?, thread_id, zone, subject, domain, size, msgs, message_ids, restore, 'pending'
           FROM gmail_cleanup_items WHERE cleanup_id = ? AND state = 'done'`,
        )
        .run(id, sourceId);
      return this.#get(id)!;
    });
    this.#launch(cleanup);
    return cleanup;
  }

  /** Retente les conversations en échec (ou laissées de côté) d'un nettoyage. */
  retry(accountId: number, cleanupId: number, target?: Target): Cleanup | null {
    const cleanup = this.#get(cleanupId);
    if (!cleanup || cleanup.accountId !== accountId || this.active(accountId)) return null;
    const only = target ? ' AND thread_id = ? AND zone = ?' : '';
    this.#gmail
      .q(`UPDATE gmail_cleanup_items SET state = 'pending', error = NULL WHERE cleanup_id = ? AND state IN ('failed', 'skipped')${only}`)
      .run(cleanupId, ...(target ? [target.id, target.zone] : []));
    this.#update(cleanupId, { status: 'running', error: null, finishedAt: null });
    this.#launch(this.#get(cleanupId)!);
    return this.#get(cleanupId);
  }

  /** Arrête le nettoyage en cours ; ce qui est fait reste fait, le reste est laissé de côté. */
  async cancel(accountId: number): Promise<void> {
    const latest = this.#latest(accountId);
    if (!latest || !this.active(accountId)) return;
    await this.#halt(accountId);
    this.#finish(latest.id, 'cancelled');
  }

  /** Reprend un nettoyage suspendu par l'expiration de l'autorisation Google. */
  resume(accountId: number): void {
    const latest = this.#latest(accountId);
    if (latest?.status !== 'auth') return;
    this.#update(latest.id, { status: 'running', error: null });
    this.#launch(latest);
  }

  /** Au démarrage du serveur : reprend les nettoyages interrompus, que l'utilisateur avait déjà confirmés. */
  resumeInterrupted(): void {
    const rows = this.#gmail.q("SELECT * FROM gmail_cleanups WHERE status = 'running'").all() as unknown as CleanupRow[];
    for (const row of rows) this.#launch(toCleanup(row));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((accountId) => this.#halt(accountId)));
  }

  /** Se résout quand plus aucun nettoyage ne tourne (utile aux tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.finished));
  }

  // --- Consultation ---

  progress(accountId: number): CleanupProgress | null {
    const latest = this.#latest(accountId);
    return latest && this.#describe(latest);
  }

  /** Journal des nettoyages, du plus récent au plus ancien. */
  journal(accountId: number): CleanupProgress[] {
    const rows = this.#gmail.q('SELECT * FROM gmail_cleanups WHERE account_id = ? ORDER BY id DESC LIMIT 100').all(accountId) as unknown as CleanupRow[];
    return rows.map((row) => this.#describe(toCleanup(row)));
  }

  items(accountId: number, cleanupId: number, state: ItemState | null, offset: number, limit: number): CleanupItem[] | null {
    const cleanup = this.#get(cleanupId);
    if (!cleanup || cleanup.accountId !== accountId) return null;
    return this.#gmail
      .q(
        `SELECT thread_id AS id, zone, subject, domain, size, msgs, state, error FROM gmail_cleanup_items
         WHERE cleanup_id = ? AND (? IS NULL OR state = ?) ORDER BY size DESC LIMIT ? OFFSET ?`,
      )
      .all(cleanupId, state, state, limit, offset) as unknown as CleanupItem[];
  }

  #describe(cleanup: Cleanup): CleanupProgress {
    const zero = () => ({ conversations: 0, messages: 0, size: 0 });
    const counts: Counts = { pending: zero(), done: zero(), failed: zero(), skipped: zero() };
    const rows = this.#gmail
      .q('SELECT state, COUNT(*) AS conversations, SUM(msgs) AS messages, SUM(size) AS size FROM gmail_cleanup_items WHERE cleanup_id = ? GROUP BY state')
      .all(cleanup.id) as unknown as ({ state: ItemState } & Counts[ItemState])[];
    for (const { state, ...rest } of rows) counts[state] = rest;
    return {
      ...cleanup,
      counts,
      retryAt: this.#runs.get(cleanup.accountId)?.retryAt ?? null,
      restorable: this.#restorable(cleanup) && counts.done.conversations > 0,
    };
  }

  #restorable(cleanup: Cleanup): boolean {
    if (cleanup.action !== 'trash' || cleanup.simulate || cleanup.status === 'running' || cleanup.status === 'auth') return false;
    return this.#gmail.q('SELECT 1 FROM gmail_cleanups WHERE source_id = ?').get(cleanup.id) === undefined;
  }

  // --- Persistance ---

  #insert(accountId: number, action: CleanupAction, simulate: boolean, sourceId: number | null): number {
    const result = this.#gmail
      .q("INSERT INTO gmail_cleanups (account_id, action, simulate, status, source_id, created_at) VALUES (?, ?, ?, 'running', ?, ?)")
      .run(accountId, action, simulate ? 1 : 0, sourceId, Date.now());
    return Number(result.lastInsertRowid);
  }

  #insertItem(
    cleanupId: number,
    brick: { id: string; zone: Zone; subject: string; domain: string; size: number; msgs: number },
    ids: string[],
    restore: string[],
  ): void {
    this.#gmail
      .q(
        `INSERT OR IGNORE INTO gmail_cleanup_items (cleanup_id, thread_id, zone, subject, domain, size, msgs, message_ids, restore, state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      )
      .run(cleanupId, brick.id, brick.zone, brick.subject, brick.domain, brick.size, brick.msgs, JSON.stringify(ids), JSON.stringify(restore));
  }

  #get(id: number): Cleanup | null {
    const row = this.#gmail.q('SELECT * FROM gmail_cleanups WHERE id = ?').get(id) as CleanupRow | undefined;
    return row ? toCleanup(row) : null;
  }

  #latest(accountId: number): Cleanup | null {
    const row = this.#gmail.q('SELECT * FROM gmail_cleanups WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId) as CleanupRow | undefined;
    return row ? toCleanup(row) : null;
  }

  #update(id: number, patch: Partial<Pick<Cleanup, 'status' | 'error' | 'finishedAt'>>): void {
    const next = { ...this.#get(id)!, ...patch };
    this.#gmail.q('UPDATE gmail_cleanups SET status = ?, error = ?, finished_at = ? WHERE id = ?').run(next.status, next.error, next.finishedAt, id);
  }

  #finish(id: number, status: 'done' | 'cancelled' | 'failed', error: string | null = null): void {
    // Ce qui n'a pas été traité est noté comme laissé de côté : le journal dit ce qui a vraiment été fait.
    this.#gmail.q("UPDATE gmail_cleanup_items SET state = 'skipped' WHERE cleanup_id = ? AND state = 'pending'").run(id);
    this.#update(id, { status, error, finishedAt: Date.now() });
  }

  #pending(cleanupId: number, limit: number): WorkItem[] {
    const rows = this.#gmail
      .q("SELECT thread_id, zone, message_ids, restore FROM gmail_cleanup_items WHERE cleanup_id = ? AND state = 'pending' LIMIT ?")
      .all(cleanupId, limit) as { thread_id: string; zone: Zone; message_ids: string; restore: string }[];
    return rows.map((row) => ({
      threadId: row.thread_id,
      zone: row.zone,
      ids: JSON.parse(row.message_ids) as string[],
      restore: JSON.parse(row.restore) as string[],
    }));
  }

  #settle(cleanupId: number, item: WorkItem, error: string | null): void {
    this.#gmail
      .q('UPDATE gmail_cleanup_items SET state = ?, error = ? WHERE cleanup_id = ? AND thread_id = ? AND zone = ?')
      .run(error ? 'failed' : 'done', error, cleanupId, item.threadId, item.zone);
  }

  // --- Exécution ---

  async #halt(accountId: number): Promise<void> {
    const run = this.#runs.get(accountId);
    if (!run) return;
    run.stop = true;
    await run.finished;
  }

  #launch(cleanup: Cleanup): void {
    if (this.#runs.has(cleanup.accountId)) return;
    const run: Run = { stop: false, retryAt: null, finished: Promise.resolve() };
    this.#runs.set(cleanup.accountId, run);
    run.finished = this.#execute(cleanup, run)
      .then(() => this.#finish(cleanup.id, 'done'))
      .catch((error: unknown) => {
        if (error instanceof Stopped) return;
        if (error instanceof ReauthRequiredError || error instanceof MissingScopeError) {
          if (error instanceof ReauthRequiredError) this.#store.markNeedsReauth(cleanup.accountId);
          this.#update(cleanup.id, { status: 'auth', error: error instanceof MissingScopeError ? 'autorisation-incomplete' : null });
          return;
        }
        this.log?.warn({ err: error, cleanupId: cleanup.id }, 'Nettoyage Gmail en échec');
        this.#finish(cleanup.id, 'failed', error instanceof RetryLaterError ? 'google-indisponible' : 'erreur-interne');
      })
      .finally(() => this.#runs.delete(cleanup.accountId));
  }

  async #execute(cleanup: Cleanup, run: Run): Promise<void> {
    const { id, accountId, action } = cleanup;
    if (cleanup.simulate) {
      // Simulation : rien n'est envoyé à Gmail, rien ne change en base ; seul le journal garde la trace.
      this.#gmail.q("UPDATE gmail_cleanup_items SET state = 'done' WHERE cleanup_id = ? AND state = 'pending'").run(id);
      return;
    }
    const tokens = this.#store.getTokens(accountId);
    if (!this.#google || !tokens) throw new ReauthRequiredError('Aucune autorisation Google en base');
    const api = this.#google.gmail(tokens, (fresh) => this.#store.saveTokens(accountId, fresh));

    if (action === 'trash' || action === 'untrash') {
      await drain(4, () => this.#pending(id, 200), (item) => this.#oneByOne(api, run, cleanup, item));
      return;
    }
    for (let items = this.#pending(id, 200); items.length > 0; items = this.#pending(id, 200)) {
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
  async #oneByOne(api: GmailApi, run: Run, cleanup: Cleanup, item: WorkItem): Promise<void> {
    const { accountId, action } = cleanup;
    const done: string[] = [];
    const gone: string[] = [];
    let failure: string | null = null;
    try {
      for (const messageId of item.ids) {
        try {
          await this.#throttle.call(run, COST[action === 'trash' ? 'trash' : 'untrash'], () =>
            action === 'trash' ? api.trashMessage(messageId) : api.untrashMessage(messageId),
          );
          done.push(messageId);
        } catch (error) {
          if (isFatal(error)) throw error;
          // Un message déjà disparu du compte n'est pas un échec : il n'y a plus rien à traiter.
          if (error instanceof NotFoundError) gone.push(messageId);
          else failure ??= reason(error);
        }
      }
      const back = action === 'untrash' ? done.filter((messageId) => item.restore.includes(messageId)) : [];
      if (back.length > 0) {
        try {
          await this.#throttle.call(run, COST.batch, () => api.batchModify(back, { add: ['INBOX'] }));
        } catch (error) {
          if (isFatal(error)) throw error;
          back.length = 0;
          failure ??= reason(error);
        }
      }
      // La base suit ce que Gmail a confirmé, message par message, même si la conversation est en échec partiel.
      if (action === 'trash') this.#gmail.changeLabels(accountId, done, { add: ['TRASH'], remove: ['INBOX'] });
      else {
        this.#gmail.changeLabels(accountId, done, { remove: ['TRASH'] });
        this.#gmail.changeLabels(accountId, back, { add: ['INBOX'] });
      }
      this.#gmail.removeMessages(accountId, gone);
      this.#settle(cleanup.id, item, failure);
    } catch (error) {
      // Arrêt en cours de conversation : ce qui est déjà fait chez Gmail est tout de même reporté en base.
      if (action === 'trash') this.#gmail.changeLabels(accountId, done, { add: ['TRASH'], remove: ['INBOX'] });
      else this.#gmail.changeLabels(accountId, done, { remove: ['TRASH'] });
      throw error;
    }
  }

  /** Suppression définitive, archivage, lu et non lu : un appel groupé pour plusieurs conversations. */
  async #grouped(api: GmailApi, run: Run, cleanup: Cleanup, items: WorkItem[]): Promise<void> {
    if (items.length === 0) return;
    const { accountId, action } = cleanup;
    const ids = items.flatMap((item) => item.ids);
    const apply = (messageIds: string[]) =>
      action === 'delete'
        ? this.#gmail.removeMessages(accountId, messageIds)
        : this.#gmail.changeLabels(accountId, messageIds, LABEL_CHANGES[action as keyof typeof LABEL_CHANGES]);
    try {
      await this.#throttle.call(run, COST.batch, () =>
        action === 'delete' ? api.batchDelete(ids) : api.batchModify(ids, LABEL_CHANGES[action as keyof typeof LABEL_CHANGES]),
      );
      apply(ids);
      for (const item of items) this.#settle(cleanup.id, item, null);
    } catch (error) {
      if (isFatal(error)) throw error;
      if (items.length === 1 && action !== 'delete') return this.#settle(cleanup.id, items[0]!, reason(error));
      // Le lot a été refusé en bloc : on reprend conversation par conversation pour isoler celle qui pose problème.
      for (const item of items) {
        if (action === 'delete') await this.#deleteOneByOne(api, run, cleanup, item);
        else await this.#grouped(api, run, cleanup, [item]);
      }
    }
  }

  async #deleteOneByOne(api: GmailApi, run: Run, cleanup: Cleanup, item: WorkItem): Promise<void> {
    const removed: string[] = [];
    let failure: string | null = null;
    try {
      for (const messageId of item.ids) {
        try {
          await this.#throttle.call(run, COST.delete, () => api.deleteMessage(messageId));
          removed.push(messageId);
        } catch (error) {
          if (isFatal(error)) throw error;
          if (error instanceof NotFoundError) removed.push(messageId);
          else failure ??= reason(error);
        }
      }
    } finally {
      this.#gmail.removeMessages(cleanup.accountId, removed);
    }
    this.#settle(cleanup.id, item, failure);
  }
}

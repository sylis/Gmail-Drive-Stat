import {
  MissingScopeError,
  NotFoundError,
  ReauthRequiredError,
  RetryLaterError,
  type GmailApi,
  type GoogleGateway,
} from '../google.js';
import type { Store } from '../store.js';
import { parseMessage } from './parse.js';
import { detailThreshold, isWholeMailbox, scopeQuery, type ScanScope } from './scope.js';
import { isActive, type GmailStore, type Scan, type ScanStats } from './store.js';

export interface ScannerOptions {
  /** Débit visé, en unités de quota Gmail par seconde (plafond Google : 250 par utilisateur). */
  unitsPerSecond?: number;
  concurrency?: number;
  /** Attente après un « ralentissez » de Google, en millisecondes, selon le nombre d'essais consécutifs. */
  backoff?: (attempt: number) => number;
  log?: { warn: (details: object, message: string) => void };
}

// Coût en unités de quota des appels utilisés (documentation Gmail).
const COST = { listThreads: 10, getThread: 10, getMessage: 5, labels: 1 };
const MAX_ATTEMPTS = 8;

/** Avancement d'un scan tel que l'interface l'affiche. */
export interface ScanProgress {
  id: number;
  scope: ScanScope;
  status: Scan['status'];
  step: Scan['step'];
  stats: ScanStats;
  threadsTotal: number;
  threadsDone: number;
  /** Google a demandé de ralentir : reprise automatique à cette date (ms). */
  retryAt: number | null;
  /** Durée restante estimée de l'étape en cours, en secondes. */
  etaSeconds: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface Run {
  scanId: number;
  stop: boolean;
  retryAt: number | null;
  /** Repère pour estimer le rythme de l'étape en cours. */
  pace: { step: string; since: number; done: number } | null;
  finished: Promise<void>;
}

class Stopped extends Error {}

/** Exécute les scans Gmail en tâche de fond, un par compte, en respectant le débit autorisé par Google. */
export class GmailScanner {
  readonly #store: Store;
  readonly #gmail: GmailStore;
  readonly #google: GoogleGateway | null;
  readonly #options: Required<Omit<ScannerOptions, 'log'>> & Pick<ScannerOptions, 'log'>;
  readonly #runs = new Map<number, Run>();
  #nextSlot = 0;

  constructor(store: Store, gmail: GmailStore, google: GoogleGateway | null, options: ScannerOptions = {}) {
    this.#store = store;
    this.#gmail = gmail;
    this.#google = google;
    this.#options = {
      unitsPerSecond: options.unitsPerSecond ?? 200,
      concurrency: options.concurrency ?? 8,
      backoff: options.backoff ?? ((attempt) => Math.min(60_000, 2000 * 2 ** (attempt - 1))),
      log: options.log,
    };
  }

  setLogger(log: ScannerOptions['log']): void {
    this.#options.log = log;
  }

  /** Lance un scan ; refuse s'il y en a déjà un en cours ou en pause pour ce compte. */
  start(accountId: number, scope: ScanScope): Scan | null {
    if (isActive(this.#gmail.latestScan(accountId))) return null;
    const scan = this.#gmail.createScan(accountId, scope);
    this.#launch(scan);
    return scan;
  }

  async pause(accountId: number): Promise<void> {
    const scan = this.#gmail.latestScan(accountId);
    if (scan?.status !== 'running') return;
    await this.#halt(accountId);
    this.#gmail.updateScan(scan.id, { status: 'paused' });
  }

  /** Reprend un scan en pause ou en attente de reconnexion. */
  resume(accountId: number): void {
    const scan = this.#gmail.latestScan(accountId);
    if (!scan || (scan.status !== 'paused' && scan.status !== 'auth')) return;
    this.#gmail.updateScan(scan.id, { status: 'running', error: null });
    this.#launch(scan);
  }

  /** Abandonne le scan ; ce qui a déjà été lu reste en base. */
  async cancel(accountId: number): Promise<void> {
    const scan = this.#gmail.latestScan(accountId);
    if (!isActive(scan)) return;
    await this.#halt(accountId);
    this.#gmail.updateScan(scan!.id, { status: 'cancelled', finishedAt: Date.now() });
  }

  /** Au démarrage du serveur : reprend les scans interrompus là où ils s'étaient arrêtés. */
  resumeInterrupted(): void {
    for (const scan of this.#gmail.interruptedScans()) this.#launch(scan);
  }

  /** Arrête tous les scans sans changer leur état, pour qu'ils reprennent au prochain démarrage. */
  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((accountId) => this.#halt(accountId)));
  }

  /** Se résout quand plus aucun scan ne tourne (utile aux tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.finished));
  }

  progress(accountId: number): ScanProgress | null {
    const scan = this.#gmail.latestScan(accountId);
    if (!scan) return null;
    const run = this.#runs.get(accountId);
    const counts = this.#gmail.queueCounts(scan.id);
    const [done, total] =
      scan.step === 'attachments' ? [scan.stats.detailDone, scan.stats.detailTotal] : [counts.done, counts.total];

    let etaSeconds: number | null = null;
    if (run?.pace && run.pace.step === scan.step && scan.step !== 'list') {
      const elapsed = (Date.now() - run.pace.since) / 1000;
      const progressed = done - run.pace.done;
      if (elapsed >= 3 && progressed > 0) etaSeconds = Math.round(((total - done) * elapsed) / progressed);
    }
    return {
      id: scan.id,
      scope: scan.scope,
      status: scan.status,
      step: scan.step,
      stats: scan.stats,
      threadsTotal: counts.total,
      threadsDone: counts.done,
      retryAt: run?.retryAt ?? null,
      etaSeconds,
      error: scan.error,
      startedAt: scan.createdAt,
      finishedAt: scan.finishedAt,
    };
  }

  async #halt(accountId: number): Promise<void> {
    const run = this.#runs.get(accountId);
    if (!run) return;
    run.stop = true;
    await run.finished;
  }

  #launch(scan: Scan): void {
    if (this.#runs.has(scan.accountId)) return;
    const run: Run = { scanId: scan.id, stop: false, retryAt: null, pace: null, finished: Promise.resolve() };
    this.#runs.set(scan.accountId, run);
    run.finished = this.#execute(scan, run)
      .catch((error: unknown) => {
        if (error instanceof Stopped) return;
        if (error instanceof ReauthRequiredError || error instanceof MissingScopeError) {
          // L'autorisation a expiré ou ne couvre pas Gmail : le scan attend la reconnexion.
          if (error instanceof ReauthRequiredError) this.#store.markNeedsReauth(scan.accountId);
          this.#gmail.updateScan(scan.id, { status: 'auth', error: error instanceof MissingScopeError ? 'autorisation-incomplete' : null });
          return;
        }
        this.#options.log?.warn({ err: error, scanId: scan.id }, 'Scan Gmail en échec');
        this.#gmail.updateScan(scan.id, {
          status: 'failed',
          error: error instanceof RetryLaterError ? 'google-indisponible' : 'erreur-interne',
          finishedAt: Date.now(),
        });
      })
      .finally(() => this.#runs.delete(scan.accountId));
  }

  async #execute(initial: Scan, run: Run): Promise<void> {
    const accountId = initial.accountId;
    const tokens = this.#store.getTokens(accountId);
    if (!this.#google || !tokens) throw new ReauthRequiredError('Aucune autorisation Google en base');
    const api = this.#google.gmail(tokens, (fresh) => this.#store.saveTokens(accountId, fresh));

    const scan = () => this.#gmail.scan(initial.id)!;
    const bump = (change: (stats: ScanStats) => void) => {
      const stats = scan().stats;
      change(stats);
      this.#gmail.updateScan(initial.id, { stats });
    };

    if (scan().step === 'list') {
      await this.#list(api, scan, run, bump);
      // Un scan de toute la boîte fait foi : ce qu'il n'a pas listé n'existe plus chez Google.
      if (isWholeMailbox(initial.scope)) this.#gmail.removeVanishedThreads(scan());
      this.#gmail.updateScan(initial.id, { step: 'read' });
    }

    const threshold = detailThreshold(initial.scope);
    if (scan().step === 'read') {
      run.pace = { step: 'read', since: Date.now(), done: this.#gmail.queueCounts(initial.id).done };
      // Quand tous les messages doivent être détaillés, une seule lecture par conversation suffit.
      const detail = threshold === 0;
      await this.#drain(
        run,
        () => this.#gmail.pendingThreads(initial.id, 500),
        async (thread) => {
          try {
            const raw = await this.#call(run, COST.getThread, () => api.getThread(thread.id, detail));
            const messages = raw.map((message) => parseMessage(message, detail));
            this.#gmail.saveThread(accountId, thread.id, thread.historyId, messages);
            bump((stats) => {
              stats.messagesRead += messages.length;
              stats.bytesRead += messages.reduce((sum, message) => sum + message.size, 0);
              stats.attachmentsFound += messages.reduce((sum, message) => sum + (message.attachments?.length ?? 0), 0);
            });
          } catch (error) {
            if (!(error instanceof NotFoundError)) throw error;
            this.#gmail.deleteThread(accountId, thread.id);
          }
          this.#gmail.markThreadDone(initial.id, thread.id);
        },
      );
      const detailTotal = this.#gmail.countPendingDetails(scan(), threshold);
      bump((stats) => {
        stats.detailTotal = detailTotal;
        stats.detailDone = 0;
      });
      this.#gmail.updateScan(initial.id, { step: 'attachments' });
    }

    run.pace = { step: 'attachments', since: Date.now(), done: scan().stats.detailDone };
    await this.#drain(
      run,
      () => this.#gmail.pendingDetails(scan(), threshold, 500),
      async (messageId) => {
        try {
          const message = parseMessage(await this.#call(run, COST.getMessage, () => api.getMessage(messageId)), true);
          this.#gmail.saveMessageDetail(accountId, message);
          bump((stats) => {
            stats.detailDone++;
            stats.attachmentsFound += message.attachments?.length ?? 0;
          });
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          this.#gmail.deleteMessage(accountId, messageId);
          bump((stats) => void stats.detailDone++);
        }
      },
    );

    this.#gmail.updateScan(initial.id, { status: 'done', finishedAt: Date.now() });
  }

  /** Étape 1 : liste les conversations du périmètre, libellé par libellé, page par page. */
  async #list(api: GmailApi, scan: () => Scan, run: Run, bump: (change: (stats: ScanStats) => void) => void): Promise<void> {
    const { scope, accountId, id } = scan();
    this.#gmail.saveLabels(accountId, await this.#call(run, COST.labels, () => api.labels()));
    const query = scopeQuery(scope);
    const labelIds: (string | undefined)[] = scope.labelIds.length > 0 ? scope.labelIds : [undefined];

    let { label, pageToken } = scan().cursor;
    for (; label < labelIds.length; label++, pageToken = null) {
      do {
        const token = pageToken ?? undefined;
        const page = await this.#call(run, COST.listThreads, () =>
          api.listThreads({ labelId: labelIds[label], query: query || undefined, pageToken: token }),
        );
        this.#gmail.enqueueThreads(scan(), page.threads);
        pageToken = page.nextPageToken ?? null;
        this.#gmail.updateScan(id, { cursor: pageToken ? { label, pageToken } : { label: label + 1, pageToken: null } });
      } while (pageToken);
      bump((stats) => void stats.labelsDone++);
    }
  }

  /** Traite une file par lots, avec plusieurs appels à Google en parallèle. */
  async #drain<T>(run: Run, nextBatch: () => T[], handle: (item: T) => Promise<void>): Promise<void> {
    for (let batch = nextBatch(); batch.length > 0; batch = nextBatch()) {
      const queue = [...batch];
      const worker = async () => {
        try {
          for (let item = queue.shift(); item !== undefined; item = queue.shift()) await handle(item);
        } catch (error) {
          // Une erreur arrête le lot entier : les autres appels en cours se terminent, sans en lancer de nouveaux.
          queue.length = 0;
          throw error;
        }
      };
      const results = await Promise.allSettled(Array.from({ length: this.#options.concurrency }, worker));
      const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
      if (failures.length > 0) throw failures.find((reason) => !(reason instanceof Stopped)) ?? failures[0];
    }
  }

  /** Appelle Google au rythme autorisé ; patiente et retente quand il demande de ralentir. */
  async #call<T>(run: Run, cost: number, request: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (run.stop) throw new Stopped();
      const now = Date.now();
      const slot = Math.max(now, this.#nextSlot);
      this.#nextSlot = slot + (cost / this.#options.unitsPerSecond) * 1000;
      if (slot > now) await pause(run, slot - now);
      try {
        const result = await request();
        run.retryAt = null;
        return result;
      } catch (error) {
        if (!(error instanceof RetryLaterError) || attempt >= MAX_ATTEMPTS) throw error;
        const wait = this.#options.backoff(attempt);
        run.retryAt = Math.max(run.retryAt ?? 0, Date.now() + wait);
        // Tous les appels en attente patientent, pas seulement celui-ci.
        this.#nextSlot = Math.max(this.#nextSlot, Date.now() + wait);
        await pause(run, wait);
      }
    }
  }
}

/** Attend `ms` millisecondes, en s'interrompant vite si le scan est mis en pause ou annulé. */
async function pause(run: Run, ms: number): Promise<void> {
  for (const until = Date.now() + ms; ; ) {
    if (run.stop) throw new Stopped();
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 200)));
  }
}

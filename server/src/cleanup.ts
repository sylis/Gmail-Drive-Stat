import type { StatementSync } from 'node:sqlite';
import { transaction, type Db } from './db.js';
import { MissingScopeError, ReauthRequiredError, RetryLaterError, NotFoundError, type GoogleGateway, type GoogleTokens } from './google.js';
import type { Store } from './store.js';
import { Stopped, Throttle, type Pacer, type ThrottleOptions } from './throttle.js';

export type CleanupStatus = 'running' | 'auth' | 'done' | 'cancelled' | 'failed';
export type ItemState = 'pending' | 'done' | 'failed' | 'skipped';

/** Un élément visé : une brique du treemap, identifiée dans sa zone. */
export interface Target {
  id: string;
  zone: string;
}

export interface Cleanup {
  id: number;
  accountId: number;
  action: string;
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

export interface CleanupItem extends Target {
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
  /** Éléments à protéger (message important, fichier partagé…) : signalés avant confirmation. */
  flagged: number;
  top: { subject: string; size: number; msgs: number }[];
}

/** Ce que la base sait d'une brique visée, tel que le journal le gardera. */
export interface BrickRow extends Target {
  subject: string;
  domain: string;
  size: number;
  msgs: number;
  flagged: number;
}

/** Travail restant pour une brique : les identifiants à traiter chez Google. */
export interface WorkItem {
  id: string;
  zone: string;
  ids: string[];
  /** Ce qu'il faudra remettre en place en cas de restauration. */
  restore: string[];
}

interface CleanupRow {
  id: number;
  account_id: number;
  action: string;
  simulate: number;
  status: CleanupStatus;
  error: string | null;
  source_id: number | null;
  created_at: number;
  finished_at: number | null;
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

/** Erreurs qui arrêtent tout le nettoyage ; les autres ne font échouer que l'élément en cours. */
export const isFatal = (error: unknown) =>
  error instanceof Stopped || error instanceof ReauthRequiredError || error instanceof MissingScopeError || error instanceof RetryLaterError;

/** Motif d'échec d'un élément, tel que l'interface l'explique. */
export function failureCode(error: unknown): string {
  if (error instanceof NotFoundError) return 'introuvable';
  const status = (error as { response?: { status?: number } }).response?.status;
  return status === 403 ? 'refus' : status === 400 ? 'requete-refusee' : 'erreur-google';
}

interface Run extends Pacer {
  finished: Promise<void>;
}

/** Accès à la base partagé avec les magasins de données : requêtes préparées mises en cache. */
export interface Sql {
  db: Db;
  q(sql: string): StatementSync;
}

/**
 * Moteur de nettoyage commun à Gmail et à Drive : il enregistre ce qui est visé, l'exécute en tâche de fond,
 * suit l'avancement et tient le journal. Chaque service fournit ses briques et ses appels à Google.
 * Règle de sûreté : Google d'abord, la base ensuite. Un élément n'est modifié en base qu'une fois
 * l'opération confirmée par Google ; un échec le laisse en place et le signale.
 */
export abstract class CleanupEngine {
  protected readonly store: Store;
  protected readonly sql: Sql;
  protected readonly google: GoogleGateway | null;
  protected readonly throttle: Throttle;
  readonly #runs = new Map<number, Run>();
  log?: { warn: (details: object, message: string) => void };

  /** Tables du journal de ce service. */
  protected abstract readonly tables: { jobs: string; items: string };
  /** Action qui met à la corbeille, et celle qui l'annule. */
  protected readonly trashAction: string = 'trash';
  protected readonly restoreAction: string = 'untrash';

  constructor(store: Store, sql: Sql, google: GoogleGateway | null, options: ThrottleOptions = {}) {
    this.store = store;
    this.sql = sql;
    this.google = google;
    this.throttle = new Throttle(options);
  }

  /** Les briques visées telles que la base les connaît ; celles qui n'y sont plus sont ignorées. */
  protected abstract bricks(accountId: number, targets: Target[]): Iterable<BrickRow>;
  /** Identifiants à traiter chez Google pour une brique, figés au moment de la confirmation. */
  protected abstract freeze(accountId: number, brick: BrickRow, action: string): { ids: string[]; restore: string[] };
  /** Exécute chez Google ce qui reste à faire, en reportant chaque résultat avec `settle`. */
  protected abstract execute(cleanup: Cleanup, pacer: Pacer, tokens: GoogleTokens): Promise<void>;

  // --- Préparation ---

  /** Ce que représente une sélection, d'après la base : c'est ce récapitulatif que l'utilisateur confirme. */
  preview(accountId: number, targets: Target[]): Preview {
    const preview: Preview = { conversations: 0, messages: 0, size: 0, flagged: 0, top: [] };
    for (const brick of this.bricks(accountId, targets)) {
      preview.conversations++;
      preview.messages += brick.msgs;
      preview.size += brick.size;
      preview.flagged += brick.flagged ? 1 : 0;
      preview.top.push({ subject: brick.subject, size: brick.size, msgs: brick.msgs });
    }
    preview.top = preview.top.sort((a, b) => b.size - a.size).slice(0, 5);
    return preview;
  }

  /** Vrai tant qu'un nettoyage tourne ou attend une reconnexion pour ce compte. */
  active(accountId: number): boolean {
    const latest = this.#latest(accountId);
    return latest !== null && (latest.status === 'running' || latest.status === 'auth');
  }

  /**
   * Enregistre un nettoyage et le lance. La liste de ce qui est visé est figée ici, à partir de la base :
   * ce qui est exécuté est exactement ce qui a été récapitulé.
   */
  start(accountId: number, action: string, targets: Target[], simulate: boolean): Cleanup | null {
    if (this.active(accountId)) return null;
    const cleanup = transaction(this.sql.db, () => {
      const id = this.#insert(accountId, action, simulate, null);
      for (const brick of this.bricks(accountId, targets)) {
        const { ids, restore } = this.freeze(accountId, brick, action);
        this.sql
          .q(
            `INSERT OR IGNORE INTO ${this.tables.items} (cleanup_id, thread_id, zone, subject, domain, size, msgs, message_ids, restore, state)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
          )
          .run(id, brick.id, brick.zone, brick.subject, brick.domain, brick.size, brick.msgs, JSON.stringify(ids), JSON.stringify(restore));
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
    const cleanup = transaction(this.sql.db, () => {
      const id = this.#insert(accountId, this.restoreAction, false, sourceId);
      this.sql
        .q(
          `INSERT INTO ${this.tables.items} (cleanup_id, thread_id, zone, subject, domain, size, msgs, message_ids, restore, state)
           SELECT ?, thread_id, zone, subject, domain, size, msgs, message_ids, restore, 'pending'
           FROM ${this.tables.items} WHERE cleanup_id = ? AND state = 'done'`,
        )
        .run(id, sourceId);
      return this.#get(id)!;
    });
    this.#launch(cleanup);
    return cleanup;
  }

  /** Retente les éléments en échec (ou laissés de côté) d'un nettoyage. */
  retry(accountId: number, cleanupId: number, target?: Target): Cleanup | null {
    const cleanup = this.#get(cleanupId);
    if (!cleanup || cleanup.accountId !== accountId || this.active(accountId)) return null;
    const only = target ? ' AND thread_id = ? AND zone = ?' : '';
    this.sql
      .q(`UPDATE ${this.tables.items} SET state = 'pending', error = NULL WHERE cleanup_id = ? AND state IN ('failed', 'skipped')${only}`)
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
    const rows = this.sql.q(`SELECT * FROM ${this.tables.jobs} WHERE status = 'running'`).all() as unknown as CleanupRow[];
    for (const row of rows) this.#launch(toCleanup(row));
  }

  async shutdown(): Promise<void> {
    await Promise.all([...this.#runs.keys()].map((accountId) => this.#halt(accountId)));
  }

  /** Se résout quand plus aucun nettoyage ne tourne (utile aux tests). */
  async idle(): Promise<void> {
    while (this.#runs.size > 0) await Promise.all([...this.#runs.values()].map((run) => run.finished));
  }

  /** Efface le journal du compte. */
  erase(accountId: number): void {
    this.sql.q(`DELETE FROM ${this.tables.jobs} WHERE account_id = ?`).run(accountId);
  }

  // --- Consultation ---

  progress(accountId: number): CleanupProgress | null {
    const latest = this.#latest(accountId);
    return latest && this.#describe(latest);
  }

  /** Journal des nettoyages, du plus récent au plus ancien. */
  journal(accountId: number): CleanupProgress[] {
    const rows = this.sql.q(`SELECT * FROM ${this.tables.jobs} WHERE account_id = ? ORDER BY id DESC LIMIT 100`).all(accountId) as unknown as CleanupRow[];
    return rows.map((row) => this.#describe(toCleanup(row)));
  }

  items(accountId: number, cleanupId: number, state: ItemState | null, offset: number, limit: number): CleanupItem[] | null {
    const cleanup = this.#get(cleanupId);
    if (!cleanup || cleanup.accountId !== accountId) return null;
    return this.sql
      .q(
        `SELECT thread_id AS id, zone, subject, domain, size, msgs, state, error FROM ${this.tables.items}
         WHERE cleanup_id = ? AND (? IS NULL OR state = ?) ORDER BY size DESC LIMIT ? OFFSET ?`,
      )
      .all(cleanupId, state, state, limit, offset) as unknown as CleanupItem[];
  }

  #describe(cleanup: Cleanup): CleanupProgress {
    const zero = () => ({ conversations: 0, messages: 0, size: 0 });
    const counts: Counts = { pending: zero(), done: zero(), failed: zero(), skipped: zero() };
    const rows = this.sql
      .q(`SELECT state, COUNT(*) AS conversations, SUM(msgs) AS messages, SUM(size) AS size FROM ${this.tables.items} WHERE cleanup_id = ? GROUP BY state`)
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
    if (cleanup.action !== this.trashAction || cleanup.simulate || cleanup.status === 'running' || cleanup.status === 'auth') return false;
    return this.sql.q(`SELECT 1 FROM ${this.tables.jobs} WHERE source_id = ?`).get(cleanup.id) === undefined;
  }

  // --- Persistance ---

  #insert(accountId: number, action: string, simulate: boolean, sourceId: number | null): number {
    const result = this.sql
      .q(`INSERT INTO ${this.tables.jobs} (account_id, action, simulate, status, source_id, created_at) VALUES (?, ?, ?, 'running', ?, ?)`)
      .run(accountId, action, simulate ? 1 : 0, sourceId, Date.now());
    return Number(result.lastInsertRowid);
  }

  #get(id: number): Cleanup | null {
    const row = this.sql.q(`SELECT * FROM ${this.tables.jobs} WHERE id = ?`).get(id) as CleanupRow | undefined;
    return row ? toCleanup(row) : null;
  }

  #latest(accountId: number): Cleanup | null {
    const row = this.sql.q(`SELECT * FROM ${this.tables.jobs} WHERE account_id = ? ORDER BY id DESC LIMIT 1`).get(accountId) as CleanupRow | undefined;
    return row ? toCleanup(row) : null;
  }

  #update(id: number, patch: Partial<Pick<Cleanup, 'status' | 'error' | 'finishedAt'>>): void {
    const next = { ...this.#get(id)!, ...patch };
    this.sql.q(`UPDATE ${this.tables.jobs} SET status = ?, error = ?, finished_at = ? WHERE id = ?`).run(next.status, next.error, next.finishedAt, id);
  }

  #finish(id: number, status: 'done' | 'cancelled' | 'failed', error: string | null = null): void {
    // Ce qui n'a pas été traité est noté comme laissé de côté : le journal dit ce qui a vraiment été fait.
    this.sql.q(`UPDATE ${this.tables.items} SET state = 'skipped' WHERE cleanup_id = ? AND state = 'pending'`).run(id);
    this.#update(id, { status, error, finishedAt: Date.now() });
  }

  /** Prochains éléments à traiter. */
  protected pending(cleanupId: number, limit: number): WorkItem[] {
    const rows = this.sql
      .q(`SELECT thread_id, zone, message_ids, restore FROM ${this.tables.items} WHERE cleanup_id = ? AND state = 'pending' LIMIT ?`)
      .all(cleanupId, limit) as { thread_id: string; zone: string; message_ids: string; restore: string }[];
    return rows.map((row) => ({
      id: row.thread_id,
      zone: row.zone,
      ids: JSON.parse(row.message_ids) as string[],
      restore: JSON.parse(row.restore) as string[],
    }));
  }

  /** Note le résultat d'un élément : fait, ou en échec avec son motif. */
  protected settle(cleanupId: number, item: WorkItem, error: string | null): void {
    this.sql
      .q(`UPDATE ${this.tables.items} SET state = ?, error = ? WHERE cleanup_id = ? AND thread_id = ? AND zone = ?`)
      .run(error ? 'failed' : 'done', error, cleanupId, item.id, item.zone);
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
    run.finished = this.#run(cleanup, run)
      .then(() => this.#finish(cleanup.id, 'done'))
      .catch((error: unknown) => {
        if (error instanceof Stopped) return;
        if (error instanceof ReauthRequiredError || error instanceof MissingScopeError) {
          if (error instanceof ReauthRequiredError) this.store.markNeedsReauth(cleanup.accountId);
          this.#update(cleanup.id, { status: 'auth', error: error instanceof MissingScopeError ? 'autorisation-incomplete' : null });
          return;
        }
        this.log?.warn({ err: error, cleanupId: cleanup.id }, 'Nettoyage en échec');
        this.#finish(cleanup.id, 'failed', error instanceof RetryLaterError ? 'google-indisponible' : 'erreur-interne');
      })
      .finally(() => this.#runs.delete(cleanup.accountId));
  }

  async #run(cleanup: Cleanup, run: Run): Promise<void> {
    if (cleanup.simulate) {
      // Simulation : rien n'est envoyé à Google, rien ne change en base ; seul le journal garde la trace.
      this.sql.q(`UPDATE ${this.tables.items} SET state = 'done' WHERE cleanup_id = ? AND state = 'pending'`).run(cleanup.id);
      return;
    }
    const tokens = this.store.getTokens(cleanup.accountId);
    if (!this.google || !tokens) throw new ReauthRequiredError('Aucune autorisation Google en base');
    await this.execute(cleanup, run, tokens);
  }
}

import type { StatementSync } from 'node:sqlite';
import { transaction, type Db } from '../db.js';
import { computeBricks, type BrickMessage } from './bricks.js';
import { zoneOf, type AttType, type ParsedMessage, type Zone } from './parse.js';
import type { ScanScope } from './scope.js';

export type ScanStatus = 'running' | 'paused' | 'auth' | 'done' | 'cancelled' | 'failed';
export type ScanStep = 'list' | 'read' | 'attachments';

/** Compteurs d'un scan, cumulés au fil de ses reprises. */
export interface ScanStats {
  messagesRead: number;
  bytesRead: number;
  attachmentsFound: number;
  labelsDone: number;
  labelsTotal: number;
  detailTotal: number;
  detailDone: number;
}

export interface Scan {
  id: number;
  accountId: number;
  scope: ScanScope;
  status: ScanStatus;
  step: ScanStep;
  /** Où reprendre l'étape de liste. */
  cursor: { label: number; pageToken: string | null };
  stats: ScanStats;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface ScanRow {
  id: number;
  account_id: number;
  scope: string;
  status: ScanStatus;
  step: ScanStep;
  cursor: string;
  stats: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

const ACTIVE: ScanStatus[] = ['running', 'paused', 'auth'];
export const isActive = (scan: Pick<Scan, 'status'> | null): boolean => scan !== null && ACTIVE.includes(scan.status);

const toScan = (row: ScanRow): Scan => ({
  id: row.id,
  accountId: row.account_id,
  scope: JSON.parse(row.scope) as ScanScope,
  status: row.status,
  step: row.step,
  cursor: JSON.parse(row.cursor) as Scan['cursor'],
  stats: JSON.parse(row.stats) as ScanStats,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  finishedAt: row.finished_at,
});

/** Métadonnées Gmail en base : conversations, messages, pièces jointes, briques du treemap et état des scans. */
export class GmailStore {
  readonly db: Db;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: Db) {
    this.db = db;
  }

  /** Requête préparée, mise en cache : les mêmes reviennent des milliers de fois pendant un scan. */
  q(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) this.#statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // --- Libellés ---

  saveLabels(accountId: number, labels: { id: string; name: string; type: string }[]): void {
    transaction(this.db, () => {
      this.q('DELETE FROM gmail_labels WHERE account_id = ?').run(accountId);
      for (const label of labels) {
        this.q('INSERT INTO gmail_labels (account_id, id, name, type) VALUES (?, ?, ?, ?)').run(accountId, label.id, label.name, label.type);
      }
    });
  }

  labels(accountId: number): { id: string; name: string; type: string }[] {
    return this.q('SELECT id, name, type FROM gmail_labels WHERE account_id = ? ORDER BY name').all(accountId) as never;
  }

  // --- Conversations ---

  /**
   * Remplace le contenu d'une conversation par ce que Gmail vient de renvoyer.
   * Un message relu sans le détail de ses pièces jointes conserve celui déjà connu.
   */
  saveThread(accountId: number, threadId: string, historyId: string, messages: ParsedMessage[]): void {
    transaction(this.db, () => {
      this.q(
        `INSERT INTO gmail_threads (account_id, id, history_id, scanned_at) VALUES (?, ?, ?, ?)
         ON CONFLICT DO UPDATE SET history_id = excluded.history_id, scanned_at = excluded.scanned_at`,
      ).run(accountId, threadId, historyId, Date.now());

      const kept = new Set(messages.map((message) => message.id));
      const known = this.q('SELECT id FROM gmail_messages WHERE account_id = ? AND thread_id = ?').all(accountId, threadId) as { id: string }[];
      for (const { id } of known) {
        if (!kept.has(id)) this.q('DELETE FROM gmail_messages WHERE account_id = ? AND id = ?').run(accountId, id);
      }
      for (const message of messages) this.#writeMessage(accountId, message);
      this.#rebuildBricks(accountId, threadId);
    });
  }

  /** Enregistre un message relu avec le détail de ses pièces jointes. */
  saveMessageDetail(accountId: number, message: ParsedMessage): void {
    transaction(this.db, () => {
      this.#writeMessage(accountId, message);
      this.#rebuildBricks(accountId, message.threadId);
    });
  }

  deleteThread(accountId: number, threadId: string): void {
    this.q('DELETE FROM gmail_threads WHERE account_id = ? AND id = ?').run(accountId, threadId);
  }

  deleteMessage(accountId: number, messageId: string): void {
    this.q('DELETE FROM gmail_messages WHERE account_id = ? AND id = ?').run(accountId, messageId);
  }

  #writeMessage(accountId: number, message: ParsedMessage): void {
    this.q(
      `INSERT INTO gmail_messages
         (account_id, id, thread_id, zone, size, date, from_addr, from_name, from_domain, rcpt, subject, list_id, labels, att_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET
         thread_id = excluded.thread_id, zone = excluded.zone, size = excluded.size, date = excluded.date,
         from_addr = excluded.from_addr, from_name = excluded.from_name, from_domain = excluded.from_domain,
         rcpt = excluded.rcpt, subject = excluded.subject, list_id = excluded.list_id, labels = excluded.labels,
         att_count = COALESCE(excluded.att_count, gmail_messages.att_count)`,
    ).run(
      accountId,
      message.id,
      message.threadId,
      message.zone,
      message.size,
      message.date,
      message.fromAddr,
      message.fromName,
      message.fromDomain,
      message.rcpt,
      message.subject,
      message.listId,
      JSON.stringify(message.labelIds),
      message.attachments?.length ?? null,
    );
    if (message.attachments === null) return;
    this.q('DELETE FROM gmail_attachments WHERE account_id = ? AND message_id = ?').run(accountId, message.id);
    message.attachments.forEach((attachment, index) =>
      this.q('INSERT INTO gmail_attachments (account_id, message_id, idx, name, type, size) VALUES (?, ?, ?, ?, ?, ?)').run(
        accountId,
        message.id,
        index,
        attachment.name,
        attachment.type,
        attachment.size,
      ),
    );
  }

  /** Applique en base un changement de libellés que Gmail vient de confirmer, et reclasse les conversations touchées. */
  changeLabels(accountId: number, messageIds: string[], change: { add?: string[]; remove?: string[] }): void {
    transaction(this.db, () => {
      const threads = new Set<string>();
      for (const id of messageIds) {
        const row = this.q('SELECT thread_id, labels FROM gmail_messages WHERE account_id = ? AND id = ?').get(accountId, id) as
          | { thread_id: string; labels: string }
          | undefined;
        if (!row) continue;
        const labels = new Set(JSON.parse(row.labels) as string[]);
        for (const label of change.remove ?? []) labels.delete(label);
        for (const label of change.add ?? []) labels.add(label);
        this.q('UPDATE gmail_messages SET labels = ?, zone = ? WHERE account_id = ? AND id = ?').run(
          JSON.stringify([...labels]),
          zoneOf([...labels]),
          accountId,
          id,
        );
        threads.add(row.thread_id);
      }
      for (const threadId of threads) this.#rebuildBricks(accountId, threadId);
    });
  }

  /** Retire de la base des messages que Gmail vient de supprimer définitivement. */
  removeMessages(accountId: number, messageIds: string[]): void {
    transaction(this.db, () => {
      const threads = new Set<string>();
      for (const id of messageIds) {
        const row = this.q('DELETE FROM gmail_messages WHERE account_id = ? AND id = ? RETURNING thread_id').get(accountId, id) as
          | { thread_id: string }
          | undefined;
        if (row) threads.add(row.thread_id);
      }
      for (const threadId of threads) this.#rebuildBricks(accountId, threadId);
    });
  }

  /** Recalcule les briques d'une conversation ; à appeler dans une transaction après toute modification de ses messages. */
  rebuildBricks(accountId: number, threadId: string): void {
    this.#rebuildBricks(accountId, threadId);
  }

  #rebuildBricks(accountId: number, threadId: string): void {
    const rows = this.q(
      `SELECT id, zone, size, date, from_addr, from_domain, rcpt, subject, list_id, labels, att_count
       FROM gmail_messages WHERE account_id = ? AND thread_id = ?`,
    ).all(accountId, threadId) as unknown as {
      id: string;
      zone: Zone;
      size: number;
      date: number;
      from_addr: string;
      from_domain: string;
      rcpt: string;
      subject: string;
      list_id: string;
      labels: string;
      att_count: number | null;
    }[];
    const attachments = this.q(
      `SELECT a.message_id, a.type, a.size FROM gmail_attachments a
       JOIN gmail_messages m ON m.account_id = a.account_id AND m.id = a.message_id
       WHERE m.account_id = ? AND m.thread_id = ?`,
    ).all(accountId, threadId) as { message_id: string; type: AttType; size: number }[];

    const messages: BrickMessage[] = rows.map((row) => ({
      zone: row.zone,
      size: row.size,
      date: row.date,
      fromAddr: row.from_addr,
      fromDomain: row.from_domain,
      rcpt: row.rcpt,
      subject: row.subject,
      listId: row.list_id,
      labelIds: JSON.parse(row.labels) as string[],
      attachments: row.att_count === null ? null : attachments.filter((attachment) => attachment.message_id === row.id),
    }));

    this.q('DELETE FROM gmail_bricks WHERE account_id = ? AND thread_id = ?').run(accountId, threadId);
    if (messages.length === 0) {
      this.deleteThread(accountId, threadId);
      return;
    }
    const names = new Map(this.labels(accountId).map((label) => [label.id, label.name]));
    for (const brick of computeBricks(messages, (id) => names.get(id))) {
      this.q(
        `INSERT INTO gmail_bricks
           (account_id, thread_id, zone, size, msgs, date, year, quarter, month, domain, sender, label, category, list, rcpt,
            att_count, att_bucket, att_type, subject, flagged)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        accountId,
        threadId,
        brick.zone,
        brick.size,
        brick.msgs,
        brick.date,
        brick.year,
        brick.quarter,
        brick.month,
        brick.domain,
        brick.sender,
        brick.label,
        brick.category,
        brick.list,
        brick.rcpt,
        brick.attCount,
        brick.attBucket,
        brick.attType,
        brick.subject,
        brick.flagged ? 1 : 0,
      );
    }
  }

  /** Efface toutes les métadonnées Gmail du compte, scans compris. */
  eraseAll(accountId: number): void {
    transaction(this.db, () => {
      this.q('DELETE FROM gmail_threads WHERE account_id = ?').run(accountId);
      this.q('DELETE FROM gmail_scans WHERE account_id = ?').run(accountId);
      this.q('DELETE FROM gmail_cleanups WHERE account_id = ?').run(accountId);
      this.q('DELETE FROM gmail_labels WHERE account_id = ?').run(accountId);
    });
  }

  // --- Scans ---

  createScan(accountId: number, scope: ScanScope): Scan {
    const now = Date.now();
    const stats: ScanStats = {
      messagesRead: 0,
      bytesRead: 0,
      attachmentsFound: 0,
      labelsDone: 0,
      labelsTotal: Math.max(scope.labelIds.length, 1),
      detailTotal: 0,
      detailDone: 0,
    };
    // Les files des scans terminés ne servent plus.
    this.q('DELETE FROM gmail_scan_threads WHERE scan_id IN (SELECT id FROM gmail_scans WHERE account_id = ?)').run(accountId);
    const result = this.q(
      `INSERT INTO gmail_scans (account_id, scope, status, step, cursor, stats, created_at, updated_at)
       VALUES (?, ?, 'running', 'list', ?, ?, ?, ?)`,
    ).run(accountId, JSON.stringify(scope), JSON.stringify({ label: 0, pageToken: null }), JSON.stringify(stats), now, now);
    return this.scan(Number(result.lastInsertRowid))!;
  }

  scan(id: number): Scan | null {
    const row = this.q('SELECT * FROM gmail_scans WHERE id = ?').get(id) as ScanRow | undefined;
    return row ? toScan(row) : null;
  }

  latestScan(accountId: number): Scan | null {
    const row = this.q('SELECT * FROM gmail_scans WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId) as ScanRow | undefined;
    return row ? toScan(row) : null;
  }

  /** Scans laissés « en cours » par un arrêt du serveur. */
  interruptedScans(): Scan[] {
    return (this.q("SELECT * FROM gmail_scans WHERE status = 'running'").all() as unknown as ScanRow[]).map(toScan);
  }

  updateScan(id: number, patch: Partial<Pick<Scan, 'status' | 'step' | 'cursor' | 'stats' | 'error' | 'finishedAt'>>): void {
    const current = this.scan(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.q(
      'UPDATE gmail_scans SET status = ?, step = ?, cursor = ?, stats = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?',
    ).run(next.status, next.step, JSON.stringify(next.cursor), JSON.stringify(next.stats), next.error, next.finishedAt, Date.now(), id);
  }

  /** Périmètres des scans menés à terme, du plus récent au plus ancien. */
  doneScopes(accountId: number): { scope: ScanScope; finishedAt: number }[] {
    const rows = this.q(
      "SELECT scope, finished_at FROM gmail_scans WHERE account_id = ? AND status = 'done' ORDER BY id DESC LIMIT 20",
    ).all(accountId) as { scope: string; finished_at: number }[];
    return rows.map((row) => ({ scope: JSON.parse(row.scope) as ScanScope, finishedAt: row.finished_at }));
  }

  /** Met des conversations en file ; celles que la base connaît déjà à l'identique sont notées lues d'emblée. */
  enqueueThreads(scan: Scan, threads: { id: string; historyId: string }[]): void {
    transaction(this.db, () => {
      for (const thread of threads) {
        this.q(
          `INSERT OR IGNORE INTO gmail_scan_threads (scan_id, thread_id, history_id, done)
           VALUES (?, ?, ?, EXISTS (SELECT 1 FROM gmail_threads WHERE account_id = ? AND id = ? AND history_id = ?))`,
        ).run(scan.id, thread.id, thread.historyId, scan.accountId, thread.id, thread.historyId);
      }
    });
  }

  pendingThreads(scanId: number, limit: number): { id: string; historyId: string }[] {
    return this.q(
      'SELECT thread_id AS id, history_id AS historyId FROM gmail_scan_threads WHERE scan_id = ? AND done = 0 LIMIT ?',
    ).all(scanId, limit) as never;
  }

  markThreadDone(scanId: number, threadId: string): void {
    this.q('UPDATE gmail_scan_threads SET done = 1 WHERE scan_id = ? AND thread_id = ?').run(scanId, threadId);
  }

  queueCounts(scanId: number): { total: number; done: number } {
    const row = this.q('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM gmail_scan_threads WHERE scan_id = ?').get(scanId) as {
      total: number;
      done: number;
    };
    return row;
  }

  /** Messages du scan assez gros pour mériter le détail de leurs pièces jointes, et pas encore détaillés. */
  pendingDetails(scan: Scan, minSize: number, limit: number): string[] {
    const rows = this.q(
      `SELECT m.id FROM gmail_scan_threads s
       JOIN gmail_messages m ON m.account_id = ? AND m.thread_id = s.thread_id
       WHERE s.scan_id = ? AND m.att_count IS NULL AND m.size >= ? LIMIT ?`,
    ).all(scan.accountId, scan.id, minSize, limit) as { id: string }[];
    return rows.map((row) => row.id);
  }

  countPendingDetails(scan: Scan, minSize: number): number {
    const row = this.q(
      `SELECT COUNT(*) AS n FROM gmail_scan_threads s
       JOIN gmail_messages m ON m.account_id = ? AND m.thread_id = s.thread_id
       WHERE s.scan_id = ? AND m.att_count IS NULL AND m.size >= ?`,
    ).get(scan.accountId, scan.id, minSize) as { n: number };
    return row.n;
  }

  /** Après un scan de toute la boîte : retire les conversations que Gmail ne liste plus. */
  removeVanishedThreads(scan: Scan): number {
    const result = this.q(
      `DELETE FROM gmail_threads WHERE account_id = ?
       AND id NOT IN (SELECT thread_id FROM gmail_scan_threads WHERE scan_id = ?)`,
    ).run(scan.accountId, scan.id);
    return Number(result.changes);
  }
}

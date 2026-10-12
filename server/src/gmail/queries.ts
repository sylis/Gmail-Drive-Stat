import { TreeBuilder, type TreeBrick, type TreeNode } from '../tree.js';
import type { Zone } from './parse.js';
import type { GmailStore } from './store.js';

export type { TreeBrick, TreeNode };

/** Axes de regroupement : chacun sert de niveau du treemap et de filtre. */
const AXES = {
  year: 'CAST(b.year AS TEXT)',
  quarter: "'T' || b.quarter",
  month: "printf('%02d', b.month)",
  label: 'b.label',
  sender: 'b.sender',
  domain: 'b.domain',
  list: 'b.list',
  group: 'b.rcpt',
  category: 'b.category',
  attBucket: 'b.att_bucket',
  attType: 'b.att_type',
} as const;
export type Axis = keyof typeof AXES;
export const isAxis = (value: unknown): value is Axis => typeof value === 'string' && value in AXES;

export interface Filters {
  /** Bornes incluses sur la date de la conversation, AAAA-MM-JJ. */
  dateFrom?: string;
  dateTo?: string;
  /** Taille minimale de la conversation, en octets. */
  minSize?: number;
  /** Valeurs retenues (ou écartées) par axe. */
  axes?: Partial<Record<Axis, { values: string[]; exclude?: boolean }>>;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Valide des filtres reçus du navigateur ; ce qui est mal formé est ignoré. */
export function parseFilters(input: unknown): Filters {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const filters: Filters = {};
  if (typeof raw.dateFrom === 'string' && DAY.test(raw.dateFrom)) filters.dateFrom = raw.dateFrom;
  if (typeof raw.dateTo === 'string' && DAY.test(raw.dateTo)) filters.dateTo = raw.dateTo;
  if (typeof raw.minSize === 'number' && raw.minSize > 0) filters.minSize = Math.floor(raw.minSize);
  const axes = (typeof raw.axes === 'object' && raw.axes !== null ? raw.axes : {}) as Record<string, unknown>;
  for (const [axis, value] of Object.entries(axes)) {
    const entry = value as { values?: unknown; exclude?: unknown } | null;
    if (!isAxis(axis) || !entry || !Array.isArray(entry.values)) continue;
    const values = entry.values.filter((item): item is string => typeof item === 'string').slice(0, 500);
    if (values.length > 0) (filters.axes ??= {})[axis] = { values, exclude: entry.exclude === true };
  }
  return filters;
}

type Param = string | number;
interface Where {
  sql: string;
  params: Param[];
}

/** Condition SQL sur les briques (alias b) ; `skip` ignore le filtre d'un axe, pour lister ses propres valeurs. */
function where(accountId: number, zone: Zone | null, filters: Filters, skip?: Axis): Where {
  const clauses = ['b.account_id = ?'];
  const params: Param[] = [accountId];
  if (zone) {
    clauses.push('b.zone = ?');
    params.push(zone);
  }
  if (filters.dateFrom) {
    clauses.push('b.date >= ?');
    params.push(Date.parse(filters.dateFrom));
  }
  if (filters.dateTo) {
    clauses.push('b.date < ?');
    params.push(Date.parse(filters.dateTo) + 24 * 3600 * 1000);
  }
  if (filters.minSize) {
    clauses.push('b.size >= ?');
    params.push(filters.minSize);
  }
  for (const [axis, entry] of Object.entries(filters.axes ?? {}) as [Axis, { values: string[]; exclude?: boolean }][]) {
    if (axis === skip) continue;
    clauses.push(`${AXES[axis]} ${entry.exclude ? 'NOT IN' : 'IN'} (${entry.values.map(() => '?').join(', ')})`);
    params.push(...entry.values);
  }
  return { sql: clauses.join(' AND '), params };
}

function withPath(base: Where, levels: Axis[], path: string[]): Where {
  const sql = [base.sql, ...path.map((_, index) => `${AXES[levels[index]!]} = ?`)].join(' AND ');
  return { sql, params: [...base.params, ...path] };
}

const ZONE_BRICKS = 400;

export interface TreemapQuery {
  levels: Axis[];
  /** Blocs dans lesquels on a zoomé, un par niveau en partant du premier. */
  path: string[];
  filters: Filters;
}

export class GmailQueries {
  readonly #store: GmailStore;

  constructor(store: GmailStore) {
    this.#store = store;
  }

  /** Arbre du treemap des messages reçus : blocs par niveau, puis une brique par conversation. */
  treemap(accountId: number, { levels, path, filters }: TreemapQuery): TreeNode {
    const open = levels.slice(path.length);
    const condition = withPath(where(accountId, 'inbox', filters), levels, path);
    const keys = open.map((axis, index) => `, ${AXES[axis]} AS k${index}`).join('');
    const rows = this.#store
      .q(`SELECT b.thread_id AS id, b.size AS v, b.att_type AS t${keys} FROM gmail_bricks b WHERE ${condition.sql} ORDER BY b.size DESC`)
      .iterate(...condition.params) as Iterable<{ id: string; v: number; t: string } & Record<string, string>>;

    const tree = new TreeBuilder();
    for (const row of rows) tree.add(open.map((_, index) => row[`k${index}`]!), { id: row.id, v: row.v, t: row.t });
    return tree.build();
  }

  /** Taille et nombre de conversations d'une zone, sous les filtres mais sans zoom. */
  total(accountId: number, zone: Zone, filters: Filters): { v: number; c: number } {
    const condition = where(accountId, zone, filters);
    return this.#store
      .q(`SELECT COALESCE(SUM(b.size), 0) AS v, COUNT(*) AS c FROM gmail_bricks b WHERE ${condition.sql}`)
      .get(...condition.params) as { v: number; c: number };
  }

  /** Zone latérale (envoyés ou corbeille) : ses plus grosses briques et son total. */
  zone(accountId: number, zone: Zone, filters: Filters): { v: number; c: number; bricks: TreeBrick[] } {
    const condition = where(accountId, zone, filters);
    const total = this.total(accountId, zone, filters);
    const bricks = this.#store
      .q(`SELECT b.thread_id AS id, b.size AS v, b.att_type AS t FROM gmail_bricks b WHERE ${condition.sql} ORDER BY b.size DESC LIMIT ?`)
      .all(...condition.params, ZONE_BRICKS) as unknown as TreeBrick[];
    return { ...total, bricks };
  }

  /** Liste triée des conversations, mêmes filtres et même zoom que le treemap. */
  list(
    accountId: number,
    query: TreemapQuery & { zone: Zone; sort: string; descending: boolean; offset: number; limit: number },
  ): { total: number; rows: ListRow[] } {
    const columns: Record<string, string> = {
      subject: 'b.subject COLLATE NOCASE',
      domain: 'b.domain',
      date: 'b.date',
      msgs: 'b.msgs',
      size: 'b.size',
    };
    const order = columns[query.sort] ?? columns.size!;
    const condition = withPath(where(accountId, query.zone, query.filters), query.levels, query.path);
    const total = this.#store.q(`SELECT COUNT(*) AS n FROM gmail_bricks b WHERE ${condition.sql}`).get(...condition.params) as { n: number };
    const rows = this.#store
      .q(
        `SELECT b.thread_id AS id, b.zone, b.subject, b.domain, b.date, b.msgs, b.size, b.att_type AS attType, b.att_count AS attCount
         FROM gmail_bricks b WHERE ${condition.sql}
         ORDER BY ${order} ${query.descending ? 'DESC' : 'ASC'}, b.thread_id LIMIT ? OFFSET ?`,
      )
      .all(...condition.params, query.limit, query.offset) as unknown as ListRow[];
    return { total: total.n, rows };
  }

  /** Toutes les briques d'une vue (filtres et zoom compris), pour les mettre dans la sélection : [conversation, taille]. */
  select(accountId: number, { levels, path, filters }: TreemapQuery, zone: Zone, limit: number): [string, number][] {
    const condition = withPath(where(accountId, zone, filters), levels, path);
    const rows = this.#store
      .q(`SELECT b.thread_id AS id, b.size FROM gmail_bricks b WHERE ${condition.sql} ORDER BY b.size DESC LIMIT ?`)
      .all(...condition.params, limit) as { id: string; size: number }[];
    return rows.map((row) => [row.id, row.size]);
  }

  /** Valeurs d'un axe avec leur poids, compte tenu des autres filtres : alimente le panneau de filtres. */
  facet(accountId: number, axis: Axis, filters: Filters, search: string): { value: string; size: number; count: number }[] {
    const condition = where(accountId, 'inbox', filters, axis);
    const like = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
    return this.#store
      .q(
        `SELECT ${AXES[axis]} AS value, SUM(b.size) AS size, COUNT(*) AS count FROM gmail_bricks b
         WHERE ${condition.sql} AND ${AXES[axis]} LIKE ? ESCAPE '\\'
         GROUP BY 1 ORDER BY size DESC LIMIT 60`,
      )
      .all(...condition.params, like) as never;
  }

  /** Détail d'une brique : la conversation, ses messages dans la zone et leurs pièces jointes. */
  conversation(accountId: number, threadId: string, zone: Zone): Conversation | null {
    const brick = this.#store
      .q(
        `SELECT thread_id AS id, zone, subject, domain, sender, date, msgs, size, label, category, list, flagged
         FROM gmail_bricks b WHERE account_id = ? AND thread_id = ? AND zone = ?`,
      )
      .get(accountId, threadId, zone) as (Omit<Conversation, 'messages' | 'attachments' | 'otherZones' | 'flagged'> & { flagged: number }) | undefined;
    if (!brick) return null;
    const messages = this.#store
      .q(
        `SELECT id, from_addr AS "from", from_name AS fromName, rcpt AS "to", subject, date, size, att_count AS attCount
         FROM gmail_messages WHERE account_id = ? AND thread_id = ? AND zone = ? ORDER BY date`,
      )
      .all(accountId, threadId, zone) as unknown as Conversation['messages'];
    const attachments = this.#store
      .q(
        `SELECT a.name, a.type, a.size FROM gmail_attachments a
         JOIN gmail_messages m ON m.account_id = a.account_id AND m.id = a.message_id
         WHERE m.account_id = ? AND m.thread_id = ? AND m.zone = ? ORDER BY a.size DESC`,
      )
      .all(accountId, threadId, zone) as unknown as Conversation['attachments'];
    const otherZones = this.#store
      .q('SELECT zone, msgs, size FROM gmail_bricks WHERE account_id = ? AND thread_id = ? AND zone <> ?')
      .all(accountId, threadId, zone) as unknown as Conversation['otherZones'];
    return { ...brick, flagged: brick.flagged === 1, messages, attachments, otherZones };
  }

  /** Plus grosses pièces jointes des conversations retenues par les filtres (hors corbeille). */
  topAttachments(accountId: number, filters: Filters, limit: number): TopAttachment[] {
    const condition = where(accountId, null, filters);
    return this.#store
      .q(
        `SELECT a.name, a.type, a.size, m.thread_id AS threadId, m.zone, m.subject, m.from_addr AS "from", m.date, b.size AS brickSize
         FROM gmail_attachments a
         JOIN gmail_messages m ON m.account_id = a.account_id AND m.id = a.message_id
         JOIN gmail_bricks b ON b.account_id = m.account_id AND b.thread_id = m.thread_id AND b.zone = m.zone
         WHERE a.account_id = ? AND m.zone <> 'trash' AND ${condition.sql}
         ORDER BY a.size DESC LIMIT ?`,
      )
      .all(accountId, ...condition.params, limit) as never;
  }

  /** Ce que contient la base pour ce compte. */
  summary(accountId: number): Summary {
    const zones = this.#store
      .q('SELECT zone, COUNT(*) AS conversations, SUM(msgs) AS messages, SUM(size) AS size FROM gmail_bricks WHERE account_id = ? GROUP BY zone')
      .all(accountId) as { zone: Zone; conversations: number; messages: number; size: number }[];
    const threads = this.#store.q('SELECT COUNT(*) AS n, MAX(scanned_at) AS last FROM gmail_threads WHERE account_id = ?').get(accountId) as {
      n: number;
      last: number | null;
    };
    const senders = this.#store
      .q('SELECT COUNT(DISTINCT from_addr) AS addresses, COUNT(DISTINCT from_domain) AS domains FROM gmail_messages WHERE account_id = ?')
      .get(accountId) as { addresses: number; domains: number };
    const range = this.#store.q('SELECT MIN(date) AS oldest, MAX(date) AS newest FROM gmail_bricks WHERE account_id = ?').get(accountId) as {
      oldest: number | null;
      newest: number | null;
    };
    const empty = { conversations: 0, messages: 0, size: 0 };
    const byZone = Object.fromEntries(zones.map(({ zone, ...rest }) => [zone, rest])) as Partial<Record<Zone, typeof empty>>;
    return {
      conversations: threads.n,
      lastScannedAt: threads.last,
      inbox: byZone.inbox ?? empty,
      sent: byZone.sent ?? empty,
      trash: byZone.trash ?? empty,
      ...senders,
      ...range,
    };
  }
}

export interface ListRow {
  id: string;
  zone: Zone;
  subject: string;
  domain: string;
  date: number;
  msgs: number;
  size: number;
  attType: string;
  attCount: number | null;
}

export interface Conversation {
  id: string;
  zone: Zone;
  subject: string;
  domain: string;
  sender: string;
  date: number;
  msgs: number;
  size: number;
  label: string;
  category: string;
  list: string;
  flagged: boolean;
  messages: { id: string; from: string; fromName: string; to: string; subject: string; date: number; size: number; attCount: number | null }[];
  attachments: { name: string; type: string; size: number }[];
  /** Les autres zones où cette conversation a aussi des messages. */
  otherZones: { zone: Zone; msgs: number; size: number }[];
}

export interface TopAttachment {
  name: string;
  type: string;
  size: number;
  threadId: string;
  zone: Zone;
  subject: string;
  from: string;
  date: number;
  /** Taille de la brique (conversation dans cette zone) qui contient la pièce jointe. */
  brickSize: number;
}

export interface Summary {
  conversations: number;
  lastScannedAt: number | null;
  inbox: { conversations: number; messages: number; size: number };
  sent: { conversations: number; messages: number; size: number };
  trash: { conversations: number; messages: number; size: number };
  addresses: number;
  domains: number;
  oldest: number | null;
  newest: number | null;
}

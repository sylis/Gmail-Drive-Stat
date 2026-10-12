import { TreeBuilder, type TreeBrick, type TreeNode } from '../tree.js';
import { SPECIAL_FOLDERS, type DriveStore } from './store.js';

/** Zone d'affichage : les fichiers en place (treemap principal) ou la corbeille Drive. */
export type DriveZone = 'files' | 'trash';
export const DRIVE_ZONES: DriveZone[] = ['files', 'trash'];

export interface DriveFilters {
  /** Familles de fichiers retenues (img, vid, pdf…). */
  types?: string[];
  /** Taille minimale, en octets. */
  minSize?: number;
  /** Bornes incluses sur la date de dernière modification, AAAA-MM-JJ. */
  modifiedFrom?: string;
  modifiedTo?: string;
  /** Texte recherché dans le nom du fichier. */
  name?: string;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Valide des filtres reçus du navigateur ; ce qui est mal formé est ignoré. */
export function parseDriveFilters(input: unknown): DriveFilters {
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  const filters: DriveFilters = {};
  if (Array.isArray(raw.types)) {
    const types = raw.types.filter((type): type is string => typeof type === 'string').slice(0, 20);
    if (types.length > 0) filters.types = types;
  }
  if (typeof raw.minSize === 'number' && raw.minSize > 0) filters.minSize = Math.floor(raw.minSize);
  if (typeof raw.modifiedFrom === 'string' && DAY.test(raw.modifiedFrom)) filters.modifiedFrom = raw.modifiedFrom;
  if (typeof raw.modifiedTo === 'string' && DAY.test(raw.modifiedTo)) filters.modifiedTo = raw.modifiedTo;
  if (typeof raw.name === 'string' && raw.name.trim()) filters.name = raw.name.trim().slice(0, 100);
  return filters;
}

export interface DriveView {
  /** Dossier sur lequel on a zoomé ; null pour tout le Drive. */
  folder: string | null;
  filters: DriveFilters;
}

type Param = string | number;

/** Condition SQL sur les fichiers (alias f) dont le compte est propriétaire, dans une zone et sous un dossier. */
function where(accountId: number, zone: DriveZone, { folder, filters }: DriveView): { sql: string; params: Param[] } {
  const clauses = ['f.account_id = ?', 'f.folder = 0', 'f.owned = 1', 'f.trashed = ?'];
  const params: Param[] = [accountId, zone === 'trash' ? 1 : 0];
  if (folder) {
    clauses.push("f.ancestors LIKE ? ESCAPE '\\'");
    params.push(`%/${folder.replace(/[\\%_]/g, '\\$&')}/%`);
  }
  if (filters.types) {
    clauses.push(`f.type IN (${filters.types.map(() => '?').join(', ')})`);
    params.push(...filters.types);
  }
  if (filters.minSize) {
    clauses.push('f.size >= ?');
    params.push(filters.minSize);
  }
  if (filters.modifiedFrom) {
    clauses.push('f.modified >= ?');
    params.push(Date.parse(filters.modifiedFrom));
  }
  if (filters.modifiedTo) {
    clauses.push('f.modified < ?');
    params.push(Date.parse(filters.modifiedTo) + 24 * 3600 * 1000);
  }
  if (filters.name) {
    clauses.push("f.name LIKE ? ESCAPE '\\'");
    params.push(`%${filters.name.replace(/[\\%_]/g, '\\$&')}%`);
  }
  return { sql: clauses.join(' AND '), params };
}

/** Au-delà de cette profondeur sous le dossier affiché, les sous-dossiers sont fondus dans leur parent. */
const MAX_DEPTH = 4;
const ZONE_BRICKS = 400;

export interface DriveFile {
  id: string;
  zone: DriveZone;
  name: string;
  /** Chemin du dossier qui contient le fichier. */
  path: string;
  mime: string;
  type: string;
  size: number;
  modified: number;
  shared: boolean;
  starred: boolean;
  link: string | null;
  /** Dossier parent : ses totaux, tous sous-dossiers compris ; null hors de tout dossier connu. */
  folder: { id: string; name: string; files: number; size: number } | null;
}

export interface DriveSummary {
  files: { count: number; size: number };
  trash: { count: number; size: number };
  folders: number;
  lastScannedAt: number | null;
}

export class DriveQueries {
  readonly #store: DriveStore;

  constructor(store: DriveStore) {
    this.#store = store;
  }

  #folderNames(accountId: number): Map<string, string> {
    const rows = this.#store.q('SELECT id, name FROM drive_files WHERE account_id = ? AND folder = 1').all(accountId) as { id: string; name: string }[];
    return new Map([...Object.entries(SPECIAL_FOLDERS), ...rows.map((row) => [row.id, row.name] as [string, string])]);
  }

  /** Arbre du treemap : par dossier (comme WinDirStat) ou par type de fichier. */
  treemap(accountId: number, view: DriveView, group: 'folder' | 'type'): TreeNode {
    const condition = where(accountId, 'files', view);
    const rows = this.#store
      .q(`SELECT f.id, f.size AS v, f.type AS t, f.ancestors FROM drive_files f WHERE ${condition.sql} ORDER BY f.size DESC`)
      .iterate(...condition.params) as Iterable<TreeBrick & { ancestors: string }>;
    const tree = new TreeBuilder();
    for (const { ancestors, ...brick } of rows) {
      if (group === 'type') tree.add([brick.t], brick);
      else {
        const chain = ancestors.split('/').filter(Boolean);
        // Ne garder que les dossiers situés sous celui sur lequel on a zoomé.
        const below = view.folder ? chain.slice(chain.indexOf(view.folder) + 1) : chain;
        tree.add(below.slice(0, MAX_DEPTH), brick);
      }
    }
    const names = group === 'folder' ? this.#folderNames(accountId) : null;
    return tree.build(names ? (key) => names.get(key) ?? 'Dossier' : undefined);
  }

  /** Corbeille Drive : ses plus gros fichiers et son total. */
  trash(accountId: number, filters: DriveFilters): { v: number; c: number; bricks: TreeBrick[] } {
    const condition = where(accountId, 'trash', { folder: null, filters });
    const total = this.#store
      .q(`SELECT COALESCE(SUM(f.size), 0) AS v, COUNT(*) AS c FROM drive_files f WHERE ${condition.sql}`)
      .get(...condition.params) as { v: number; c: number };
    const bricks = this.#store
      .q(`SELECT f.id, f.size AS v, f.type AS t FROM drive_files f WHERE ${condition.sql} AND f.size > 0 ORDER BY f.size DESC LIMIT ?`)
      .all(...condition.params, ZONE_BRICKS) as unknown as TreeBrick[];
    return { ...total, bricks };
  }

  /** Fil d'Ariane du dossier affiché, du plus haut au dossier lui-même. */
  crumbs(accountId: number, folder: string | null): { id: string; name: string }[] {
    if (!folder) return [];
    if (folder in SPECIAL_FOLDERS) return [{ id: folder, name: SPECIAL_FOLDERS[folder]! }];
    const row = this.#store.q('SELECT ancestors FROM drive_files WHERE account_id = ? AND id = ? AND folder = 1').get(accountId, folder) as
      | { ancestors: string }
      | undefined;
    if (!row) return [];
    const names = this.#folderNames(accountId);
    return [...row.ancestors.split('/').filter(Boolean), folder].map((id) => ({ id, name: names.get(id) ?? 'Dossier' }));
  }

  /** Liste triée des fichiers : les plus gros d'abord par défaut. */
  list(
    accountId: number,
    view: DriveView,
    options: { zone: DriveZone; sort: string; descending: boolean; offset: number; limit: number },
  ): { total: number; rows: DriveListRow[] } {
    const columns: Record<string, string> = {
      name: 'f.name COLLATE NOCASE',
      path: 'f.path COLLATE NOCASE',
      modified: 'f.modified',
      size: 'f.size',
    };
    const order = columns[options.sort] ?? columns.size!;
    const condition = where(accountId, options.zone, view);
    const total = this.#store.q(`SELECT COUNT(*) AS n FROM drive_files f WHERE ${condition.sql}`).get(...condition.params) as { n: number };
    const rows = this.#store
      .q(
        `SELECT f.id, f.name, f.path, f.type, f.modified, f.size, f.shared FROM drive_files f WHERE ${condition.sql}
         ORDER BY ${order} ${options.descending ? 'DESC' : 'ASC'}, f.id LIMIT ? OFFSET ?`,
      )
      .all(...condition.params, options.limit, options.offset) as unknown as (Omit<DriveListRow, 'zone' | 'shared'> & { shared: number })[];
    return { total: total.n, rows: rows.map((row) => ({ ...row, zone: options.zone, shared: row.shared === 1 })) };
  }

  /** Tous les fichiers d'une vue, pour les mettre dans la sélection : [fichier, taille]. */
  select(accountId: number, view: DriveView, zone: DriveZone, limit: number): [string, number][] {
    const condition = where(accountId, zone, view);
    const rows = this.#store
      .q(`SELECT f.id, f.size FROM drive_files f WHERE ${condition.sql} ORDER BY f.size DESC LIMIT ?`)
      .all(...condition.params, limit) as { id: string; size: number }[];
    return rows.map((row) => [row.id, row.size]);
  }

  file(accountId: number, id: string): DriveFile | null {
    const row = this.#store
      .q(
        `SELECT id, name, path, mime, type, size, modified, shared, starred, link, trashed, parent_id, ancestors
         FROM drive_files WHERE account_id = ? AND id = ? AND folder = 0 AND owned = 1`,
      )
      .get(accountId, id) as
      | (Omit<DriveFile, 'zone' | 'shared' | 'starred' | 'folder'> & { shared: number; starred: number; trashed: number; ancestors: string })
      | undefined;
    if (!row) return null;
    const { trashed, ancestors, ...file } = row;
    const parent = ancestors.split('/').filter(Boolean).at(-1);
    let folder: DriveFile['folder'] = null;
    if (parent && trashed === 0) {
      const totals = this.#store
        .q(
          `SELECT COUNT(*) AS files, COALESCE(SUM(size), 0) AS size FROM drive_files
           WHERE account_id = ? AND folder = 0 AND owned = 1 AND trashed = 0 AND ancestors LIKE ? ESCAPE '\\'`,
        )
        .get(accountId, `%/${parent.replace(/[\\%_]/g, '\\$&')}/%`) as { files: number; size: number };
      folder = { id: parent, name: this.#folderNames(accountId).get(parent) ?? 'Dossier', ...totals };
    }
    return { ...file, zone: trashed === 1 ? 'trash' : 'files', shared: row.shared === 1, starred: row.starred === 1, folder };
  }

  summary(accountId: number): DriveSummary {
    const zones = this.#store
      .q('SELECT trashed, COUNT(*) AS count, COALESCE(SUM(size), 0) AS size FROM drive_files WHERE account_id = ? AND folder = 0 AND owned = 1 GROUP BY trashed')
      .all(accountId) as { trashed: number; count: number; size: number }[];
    const folders = this.#store.q('SELECT COUNT(*) AS n FROM drive_files WHERE account_id = ? AND folder = 1 AND owned = 1').get(accountId) as { n: number };
    const zone = (trashed: number) => {
      const row = zones.find((candidate) => candidate.trashed === trashed);
      return { count: row?.count ?? 0, size: row?.size ?? 0 };
    };
    return { files: zone(0), trash: zone(1), folders: folders.n, lastScannedAt: this.#store.lastScannedAt(accountId) };
  }
}

export interface DriveListRow {
  id: string;
  zone: DriveZone;
  name: string;
  path: string;
  type: string;
  modified: number;
  size: number;
  shared: boolean;
}

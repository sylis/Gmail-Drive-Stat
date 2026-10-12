import type { StatementSync } from 'node:sqlite';
import { transaction, type Db } from '../db.js';
import { attachmentType } from '../gmail/parse.js';
import { DRIVE_FOLDER, type RawDriveFile } from '../google.js';

export type DriveScanStatus = 'running' | 'auth' | 'done' | 'cancelled' | 'failed';

export interface DriveScan {
  id: number;
  accountId: number;
  status: DriveScanStatus;
  /** Où reprendre la liste des fichiers. */
  pageToken: string | null;
  /** Identifiant du dossier « Mon Drive ». */
  rootId: string | null;
  /** Fichiers et dossiers vus jusqu'ici. */
  seen: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
}

interface ScanRow {
  id: number;
  account_id: number;
  status: DriveScanStatus;
  page_token: string | null;
  root_id: string | null;
  seen: number;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

const toScan = (row: ScanRow): DriveScan => ({
  id: row.id,
  accountId: row.account_id,
  status: row.status,
  pageToken: row.page_token,
  rootId: row.root_id,
  seen: row.seen,
  error: row.error,
  createdAt: row.created_at,
  finishedAt: row.finished_at,
});

export const isScanning = (scan: Pick<DriveScan, 'status'> | null) => scan?.status === 'running' || scan?.status === 'auth';

// Blocs de premier niveau pour les fichiers qui ne sont pas rangés dans « Mon Drive ».
export const SHARED_FOLDER = '~partage';
export const NO_FOLDER = '~sans-dossier';
export const SPECIAL_FOLDERS: Record<string, string> = {
  [SHARED_FOLDER]: 'Dans des dossiers partagés',
  [NO_FOLDER]: 'Sans dossier',
};

const GOOGLE_TYPES: Record<string, string> = {
  'application/vnd.google-apps.document': 'doc',
  'application/vnd.google-apps.spreadsheet': 'doc',
  'application/vnd.google-apps.presentation': 'doc',
  'application/vnd.google-apps.form': 'doc',
  'application/vnd.google-apps.drawing': 'img',
  'application/vnd.google-apps.photo': 'img',
  'application/vnd.google-apps.video': 'vid',
  'application/vnd.google-apps.audio': 'aud',
};

/** Famille d'un fichier, qui donne sa couleur dans le treemap : image, vidéo, PDF, bureautique… */
export const fileType = (mime: string, name: string) => GOOGLE_TYPES[mime] ?? attachmentType(mime, name);

/** Métadonnées Drive en base : fichiers, dossiers et état des scans. */
export class DriveStore {
  readonly db: Db;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: Db) {
    this.db = db;
  }

  q(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) this.#statements.set(sql, (statement = this.db.prepare(sql)));
    return statement;
  }

  // --- Scans ---

  createScan(accountId: number): DriveScan {
    const result = this.q("INSERT INTO drive_scans (account_id, status, seen, created_at) VALUES (?, 'running', 0, ?)").run(accountId, Date.now());
    return this.scan(Number(result.lastInsertRowid))!;
  }

  scan(id: number): DriveScan | null {
    const row = this.q('SELECT * FROM drive_scans WHERE id = ?').get(id) as ScanRow | undefined;
    return row ? toScan(row) : null;
  }

  latestScan(accountId: number): DriveScan | null {
    const row = this.q('SELECT * FROM drive_scans WHERE account_id = ? ORDER BY id DESC LIMIT 1').get(accountId) as ScanRow | undefined;
    return row ? toScan(row) : null;
  }

  interruptedScans(): DriveScan[] {
    return (this.q("SELECT * FROM drive_scans WHERE status = 'running'").all() as unknown as ScanRow[]).map(toScan);
  }

  updateScan(id: number, patch: Partial<Pick<DriveScan, 'status' | 'pageToken' | 'rootId' | 'seen' | 'error' | 'finishedAt'>>): void {
    const current = this.scan(id);
    if (!current) return;
    const next = { ...current, ...patch };
    this.q('UPDATE drive_scans SET status = ?, page_token = ?, root_id = ?, seen = ?, error = ?, finished_at = ? WHERE id = ?').run(
      next.status,
      next.pageToken,
      next.rootId,
      next.seen,
      next.error,
      next.finishedAt,
      id,
    );
  }

  /** Date de la dernière lecture complète du Drive. */
  lastScannedAt(accountId: number): number | null {
    const row = this.q("SELECT MAX(finished_at) AS last FROM drive_scans WHERE account_id = ? AND status = 'done'").get(accountId) as { last: number | null };
    return row.last;
  }

  // --- Fichiers ---

  /** Enregistre une page de fichiers telle que Drive vient de la renvoyer. */
  saveFiles(scan: DriveScan, files: RawDriveFile[]): void {
    transaction(this.db, () => {
      for (const file of files) {
        const mime = file.mimeType ?? '';
        const name = file.name ?? '';
        const folder = mime === DRIVE_FOLDER;
        const size = Number(file.quotaBytesUsed ?? 0);
        this.q(
          `INSERT INTO drive_files (account_id, id, name, mime, folder, type, size, parent_id, trashed, modified, shared, starred, owned, link, scan_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT DO UPDATE SET
             name = excluded.name, mime = excluded.mime, folder = excluded.folder, type = excluded.type, size = excluded.size,
             parent_id = excluded.parent_id, trashed = excluded.trashed, modified = excluded.modified, shared = excluded.shared,
             starred = excluded.starred, owned = excluded.owned, link = excluded.link, scan_id = excluded.scan_id`,
        ).run(
          scan.accountId,
          file.id,
          name,
          mime,
          folder ? 1 : 0,
          folder ? 'folder' : fileType(mime, name),
          Number.isFinite(size) && size > 0 ? size : 0,
          file.parents?.[0] ?? null,
          file.trashed ? 1 : 0,
          Date.parse(file.modifiedTime ?? '') || 0,
          file.shared ? 1 : 0,
          file.starred ? 1 : 0,
          file.ownedByMe === false ? 0 : 1,
          file.webViewLink ?? null,
          scan.id,
        );
      }
    });
  }

  /**
   * Fin de scan : retire ce que Drive n'a plus listé, puis calcule pour chaque fichier la chaîne de ses dossiers.
   * `ancestors` est la suite des identifiants (« /a/b/ »), `path` celle des noms (« Mon Drive / A / B »).
   */
  finishScan(scan: DriveScan): void {
    transaction(this.db, () => {
      this.q('DELETE FROM drive_files WHERE account_id = ? AND scan_id <> ?').run(scan.accountId, scan.id);
      this.rebuildPaths(scan.accountId, scan.rootId);
    });
  }

  rebuildPaths(accountId: number, rootId: string | null): void {
    const rows = this.q('SELECT id, name, folder, parent_id FROM drive_files WHERE account_id = ?').all(accountId) as {
      id: string;
      name: string;
      folder: number;
      parent_id: string | null;
    }[];
    const folders = new Map(rows.filter((row) => row.folder === 1).map((row) => [row.id, row]));
    const chains = new Map<string | null, { ids: string[]; names: string[] }>();

    /** Chaîne des dossiers qui mènent à `folderId`, du plus haut au plus proche. */
    const chainOf = (folderId: string | null, depth = 0): { ids: string[]; names: string[] } => {
      const known = chains.get(folderId);
      if (known) return known;
      let chain: { ids: string[]; names: string[] };
      const folder = folderId === null ? undefined : folders.get(folderId);
      if (folderId === null) chain = { ids: [NO_FOLDER], names: [SPECIAL_FOLDERS[NO_FOLDER]!] };
      else if (folderId === rootId) chain = { ids: [], names: ['Mon Drive'] };
      // Dossier inconnu ou boucle : le fichier est rangé chez quelqu'un d'autre, hors de « Mon Drive ».
      else if (!folder || depth > 60) chain = { ids: [SHARED_FOLDER], names: [SPECIAL_FOLDERS[SHARED_FOLDER]!] };
      else {
        const parent = chainOf(folder.parent_id, depth + 1);
        chain = { ids: [...parent.ids, folder.id], names: [...parent.names, folder.name] };
      }
      chains.set(folderId, chain);
      return chain;
    };

    for (const row of rows) {
      const chain = chainOf(row.parent_id);
      this.q('UPDATE drive_files SET ancestors = ?, path = ? WHERE account_id = ? AND id = ?').run(
        `/${chain.ids.map((id) => `${id}/`).join('')}`,
        chain.names.join(' / '),
        accountId,
        row.id,
      );
    }
  }

  setTrashed(accountId: number, fileId: string, trashed: boolean): void {
    this.q('UPDATE drive_files SET trashed = ? WHERE account_id = ? AND id = ?').run(trashed ? 1 : 0, accountId, fileId);
  }

  removeFile(accountId: number, fileId: string): void {
    this.q('DELETE FROM drive_files WHERE account_id = ? AND id = ?').run(accountId, fileId);
  }

  /** Efface toutes les métadonnées Drive du compte, scans et journal compris. */
  eraseAll(accountId: number): void {
    transaction(this.db, () => {
      for (const table of ['drive_files', 'drive_scans', 'drive_cleanups']) this.q(`DELETE FROM ${table} WHERE account_id = ?`).run(accountId);
    });
  }
}

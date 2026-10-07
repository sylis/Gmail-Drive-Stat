import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;

// Chaque entrée fait passer la base à la version suivante (PRAGMA user_version) ; ne jamais modifier une entrée publiée.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE accounts (
    id            INTEGER PRIMARY KEY,
    google_sub    TEXT NOT NULL UNIQUE,
    email         TEXT NOT NULL,
    name          TEXT,
    picture       TEXT,
    tokens_enc    TEXT,
    needs_reauth  INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE sessions (
    id_hash     TEXT PRIMARY KEY,
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE oauth_states (
    state_hash     TEXT PRIMARY KEY,
    code_verifier  TEXT NOT NULL,
    created_at     INTEGER NOT NULL
  ) STRICT;
  `,
  // Lot 2 : métadonnées Gmail. Tout est rattaché au compte et disparaît avec lui.
  `
  CREATE TABLE gmail_labels (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    PRIMARY KEY (account_id, id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE gmail_threads (
    account_id  INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    id          TEXT NOT NULL,
    history_id  TEXT NOT NULL,
    scanned_at  INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE gmail_messages (
    account_id   INTEGER NOT NULL,
    id           TEXT NOT NULL,
    thread_id    TEXT NOT NULL,
    zone         TEXT NOT NULL,
    size         INTEGER NOT NULL,
    date         INTEGER NOT NULL,
    from_addr    TEXT NOT NULL,
    from_name    TEXT NOT NULL,
    from_domain  TEXT NOT NULL,
    rcpt         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    list_id      TEXT NOT NULL,
    labels       TEXT NOT NULL,
    att_count    INTEGER,
    PRIMARY KEY (account_id, id),
    FOREIGN KEY (account_id, thread_id) REFERENCES gmail_threads(account_id, id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX gmail_messages_thread ON gmail_messages(account_id, thread_id);

  CREATE TABLE gmail_attachments (
    account_id  INTEGER NOT NULL,
    message_id  TEXT NOT NULL,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    PRIMARY KEY (account_id, message_id, idx),
    FOREIGN KEY (account_id, message_id) REFERENCES gmail_messages(account_id, id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX gmail_attachments_size ON gmail_attachments(account_id, size DESC);

  CREATE TABLE gmail_bricks (
    account_id  INTEGER NOT NULL,
    thread_id   TEXT NOT NULL,
    zone        TEXT NOT NULL,
    size        INTEGER NOT NULL,
    msgs        INTEGER NOT NULL,
    date        INTEGER NOT NULL,
    year        INTEGER NOT NULL,
    quarter     INTEGER NOT NULL,
    month       INTEGER NOT NULL,
    domain      TEXT NOT NULL,
    sender      TEXT NOT NULL,
    label       TEXT NOT NULL,
    category    TEXT NOT NULL,
    list        TEXT NOT NULL,
    rcpt        TEXT NOT NULL,
    att_count   INTEGER,
    att_bucket  TEXT NOT NULL,
    att_type    TEXT NOT NULL,
    subject     TEXT NOT NULL,
    flagged     INTEGER NOT NULL,
    PRIMARY KEY (account_id, thread_id, zone),
    FOREIGN KEY (account_id, thread_id) REFERENCES gmail_threads(account_id, id) ON DELETE CASCADE
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX gmail_bricks_size ON gmail_bricks(account_id, zone, size DESC);

  CREATE TABLE gmail_scans (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    scope        TEXT NOT NULL,
    status       TEXT NOT NULL,
    step         TEXT NOT NULL,
    cursor       TEXT NOT NULL,
    stats        TEXT NOT NULL,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    finished_at  INTEGER
  ) STRICT;
  CREATE INDEX gmail_scans_account ON gmail_scans(account_id, id DESC);

  CREATE TABLE gmail_scan_threads (
    scan_id     INTEGER NOT NULL REFERENCES gmail_scans(id) ON DELETE CASCADE,
    thread_id   TEXT NOT NULL,
    history_id  TEXT NOT NULL,
    done        INTEGER NOT NULL,
    PRIMARY KEY (scan_id, thread_id)
  ) STRICT, WITHOUT ROWID;
  `,
  // Lot 3 : nettoyages Gmail. Chaque ligne garde ce qui a été traité : c'est aussi le journal des actions.
  `
  CREATE TABLE gmail_cleanups (
    id           INTEGER PRIMARY KEY,
    account_id   INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    action       TEXT NOT NULL,
    simulate     INTEGER NOT NULL,
    status       TEXT NOT NULL,
    error        TEXT,
    source_id    INTEGER,
    created_at   INTEGER NOT NULL,
    finished_at  INTEGER
  ) STRICT;
  CREATE INDEX gmail_cleanups_account ON gmail_cleanups(account_id, id DESC);

  CREATE TABLE gmail_cleanup_items (
    cleanup_id   INTEGER NOT NULL REFERENCES gmail_cleanups(id) ON DELETE CASCADE,
    thread_id    TEXT NOT NULL,
    zone         TEXT NOT NULL,
    subject      TEXT NOT NULL,
    domain       TEXT NOT NULL,
    size         INTEGER NOT NULL,
    msgs         INTEGER NOT NULL,
    message_ids  TEXT NOT NULL,
    restore      TEXT NOT NULL,
    state        TEXT NOT NULL,
    error        TEXT,
    PRIMARY KEY (cleanup_id, thread_id, zone)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX gmail_cleanup_items_state ON gmail_cleanup_items(cleanup_id, state);
  `,
];

/** Exécute `work` dans une transaction, annulée si elle échoue. */
export function transaction<T>(db: Db, work: () => T): T {
  db.exec('BEGIN');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

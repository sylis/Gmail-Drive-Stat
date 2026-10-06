import type { SecretBox } from './crypto.js';
import { randomToken, sha256 } from './crypto.js';
import type { Db } from './db.js';
import type { GoogleProfile, GoogleTokens } from './google.js';

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

export interface Account {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  needsReauth: boolean;
}

interface AccountRow {
  id: number;
  email: string;
  name: string | null;
  picture: string | null;
  needs_reauth: number;
  tokens_enc: string | null;
}

export class Store {
  readonly #db: Db;
  readonly #box: SecretBox;

  constructor(db: Db, box: SecretBox) {
    this.#db = db;
    this.#box = box;
  }

  // --- Étape intermédiaire de la connexion Google ---

  createOAuthState(): { state: string; codeVerifier: string } {
    const now = Date.now();
    this.#db.prepare('DELETE FROM oauth_states WHERE created_at < ?').run(now - OAUTH_STATE_TTL_MS);
    const state = randomToken();
    const codeVerifier = randomToken(48);
    this.#db
      .prepare('INSERT INTO oauth_states (state_hash, code_verifier, created_at) VALUES (?, ?, ?)')
      .run(sha256(state), codeVerifier, now);
    return { state, codeVerifier };
  }

  /** Renvoie le vérificateur PKCE associé et consomme l'état : il ne sert qu'une fois. */
  consumeOAuthState(state: string): string | null {
    const row = this.#db
      .prepare('DELETE FROM oauth_states WHERE state_hash = ? AND created_at >= ? RETURNING code_verifier')
      .get(sha256(state), Date.now() - OAUTH_STATE_TTL_MS) as { code_verifier: string } | undefined;
    return row?.code_verifier ?? null;
  }

  // --- Comptes ---

  hasRefreshToken(googleSub: string): boolean {
    const row = this.#db.prepare('SELECT tokens_enc FROM accounts WHERE google_sub = ?').get(googleSub) as
      | Pick<AccountRow, 'tokens_enc'>
      | undefined;
    return Boolean(row?.tokens_enc && this.#decryptTokens(row.tokens_enc)?.refresh_token);
  }

  /** Crée ou met à jour le compte ; conserve l'ancien jeton de rafraîchissement si Google n'en renvoie pas de nouveau. */
  upsertAccount(profile: GoogleProfile, tokens: GoogleTokens): number {
    const now = Date.now();
    const existing = this.#db.prepare('SELECT id, tokens_enc FROM accounts WHERE google_sub = ?').get(profile.sub) as
      | Pick<AccountRow, 'id' | 'tokens_enc'>
      | undefined;
    const previous = existing?.tokens_enc ? this.#decryptTokens(existing.tokens_enc) : null;
    const merged: GoogleTokens = { ...tokens, refresh_token: tokens.refresh_token ?? previous?.refresh_token };
    const tokensEnc = this.#box.encrypt(JSON.stringify(merged));
    const name = profile.name ?? null;
    const picture = profile.picture ?? null;

    if (existing) {
      this.#db
        .prepare(
          'UPDATE accounts SET email = ?, name = ?, picture = ?, tokens_enc = ?, needs_reauth = 0, updated_at = ? WHERE id = ?',
        )
        .run(profile.email, name, picture, tokensEnc, now, existing.id);
      return existing.id;
    }
    const result = this.#db
      .prepare(
        'INSERT INTO accounts (google_sub, email, name, picture, tokens_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(profile.sub, profile.email, name, picture, tokensEnc, now, now);
    return Number(result.lastInsertRowid);
  }

  getTokens(accountId: number): GoogleTokens | null {
    const row = this.#db.prepare('SELECT tokens_enc FROM accounts WHERE id = ?').get(accountId) as
      | Pick<AccountRow, 'tokens_enc'>
      | undefined;
    return row?.tokens_enc ? this.#decryptTokens(row.tokens_enc) : null;
  }

  saveTokens(accountId: number, tokens: GoogleTokens): void {
    this.#db
      .prepare('UPDATE accounts SET tokens_enc = ?, updated_at = ? WHERE id = ?')
      .run(this.#box.encrypt(JSON.stringify(tokens)), Date.now(), accountId);
  }

  markNeedsReauth(accountId: number): void {
    this.#db.prepare('UPDATE accounts SET needs_reauth = 1, updated_at = ? WHERE id = ?').run(Date.now(), accountId);
  }

  /** Supprime le compte, ses jetons et ses sessions. */
  deleteAccount(accountId: number): void {
    this.#db.prepare('DELETE FROM accounts WHERE id = ?').run(accountId);
  }

  // --- Sessions du navigateur ---

  createSession(accountId: number): { id: string; maxAgeSeconds: number } {
    const now = Date.now();
    this.#db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    const id = randomToken();
    this.#db
      .prepare('INSERT INTO sessions (id_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256(id), accountId, now, now + SESSION_TTL_MS);
    return { id, maxAgeSeconds: SESSION_TTL_MS / 1000 };
  }

  findAccountBySession(sessionId: string): Account | null {
    const row = this.#db
      .prepare(
        `SELECT a.id, a.email, a.name, a.picture, a.needs_reauth
         FROM sessions s JOIN accounts a ON a.id = s.account_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
      )
      .get(sha256(sessionId), Date.now()) as Omit<AccountRow, 'tokens_enc'> | undefined;
    if (!row) return null;
    return { id: row.id, email: row.email, name: row.name, picture: row.picture, needsReauth: row.needs_reauth === 1 };
  }

  deleteSession(sessionId: string): void {
    this.#db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(sessionId));
  }

  #decryptTokens(tokensEnc: string): GoogleTokens | null {
    try {
      return JSON.parse(this.#box.decrypt(tokensEnc)) as GoogleTokens;
    } catch {
      // Clé de chiffrement changée : les jetons sont perdus, une reconnexion les recréera.
      return null;
    }
  }
}

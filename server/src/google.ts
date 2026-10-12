import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Config } from './config.js';

// Lot 1 : identité + lecture du quota. Lot 2 : lecture de Gmail. Lot 3 : accès complet à Gmail, seul à permettre
// la suppression définitive (la corbeille, l'archivage et lu/non lu se contenteraient de gmail.modify).
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const GMAIL_FULL_SCOPE = 'https://mail.google.com/';
// Lot 4 : accès complet à Drive, pour mettre des fichiers à la corbeille ou les supprimer.
export const DRIVE_FULL_SCOPE = 'https://www.googleapis.com/auth/drive';
export const SCOPES = ['openid', 'email', 'profile', DRIVE_METADATA_SCOPE, GMAIL_FULL_SCOPE, DRIVE_FULL_SCOPE];

const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
const DRIVE = 'https://www.googleapis.com/drive/v3';
export const DRIVE_FOLDER = 'application/vnd.google-apps.folder';

export interface GoogleTokens {
  refresh_token?: string | null;
  access_token?: string | null;
  expiry_date?: number | null;
  scope?: string;
}

export interface GoogleProfile {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
  picture?: string;
}

/** Valeurs brutes de l'API Drive (about.storageQuota), en octets sous forme de chaînes. */
export interface RawStorageQuota {
  limit?: string;
  usage?: string;
  usageInDrive?: string;
  usageInDriveTrash?: string;
}

export interface RawGmailPart {
  mimeType?: string;
  filename?: string;
  headers?: { name: string; value: string }[];
  body?: { size?: number; attachmentId?: string };
  parts?: RawGmailPart[];
}

/** Message tel que le renvoie l'API Gmail, limité aux métadonnées : le corps n'est jamais demandé. */
export interface RawGmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  sizeEstimate?: number;
  internalDate?: string;
  payload?: RawGmailPart;
}

/** Fichier ou dossier tel que le renvoie l'API Drive : métadonnées seulement. */
export interface RawDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  /** Espace compté dans le quota, en octets sous forme de chaîne ; absent ou nul pour un dossier ou un Google Docs. */
  quotaBytesUsed?: string;
  parents?: string[];
  trashed?: boolean;
  modifiedTime?: string;
  shared?: boolean;
  starred?: boolean;
  ownedByMe?: boolean;
  webViewLink?: string;
}

export interface DriveApi {
  /** Identifiant du dossier racine « Mon Drive ». */
  rootId(): Promise<string>;
  /** Une page des fichiers dont le compte est propriétaire, et de tous les dossiers visibles (pour reconstituer les chemins). */
  listFiles(pageToken?: string): Promise<{ files: RawDriveFile[]; nextPageToken?: string }>;

  // --- Écritures : exigent l'accès complet à Drive ---

  /** Met un fichier à la corbeille ; Drive le supprime de lui-même au bout de 30 jours. */
  trashFile(id: string): Promise<void>;
  untrashFile(id: string): Promise<void>;
  /** Supprime définitivement un fichier, sans passer par la corbeille. Irréversible. */
  deleteFile(id: string): Promise<void>;
}

export interface GmailApi {
  profile(): Promise<{ messagesTotal: number; threadsTotal: number }>;
  labels(): Promise<{ id: string; name: string; type: string }[]>;
  listThreads(options: {
    labelId?: string;
    query?: string;
    pageToken?: string;
  }): Promise<{ threads: { id: string; historyId: string }[]; nextPageToken?: string }>;
  /** Tous les messages de la conversation ; `detail` ajoute la structure des pièces jointes. */
  getThread(id: string, detail: boolean): Promise<RawGmailMessage[]>;
  /** Un message avec la structure de ses pièces jointes. */
  getMessage(id: string): Promise<RawGmailMessage>;

  // --- Écritures : exigent l'accès complet à Gmail ---

  /** Met un message à la corbeille ; Gmail le supprime de lui-même au bout de 30 jours. */
  trashMessage(id: string): Promise<void>;
  untrashMessage(id: string): Promise<void>;
  /** Supprime définitivement un message, sans passer par la corbeille. Irréversible. */
  deleteMessage(id: string): Promise<void>;
  /** Supprime définitivement jusqu'à 1000 messages en un appel. Irréversible. */
  batchDelete(ids: string[]): Promise<void>;
  /** Ajoute et retire des libellés sur jusqu'à 1000 messages en un appel. */
  batchModify(ids: string[], change: { add?: string[]; remove?: string[] }): Promise<void>;
}

/** Google a retiré l'autorisation (expiration du mode test, révocation) : l'utilisateur doit se reconnecter. */
export class ReauthRequiredError extends Error {}

/** L'utilisateur a décoché une autorisation nécessaire sur l'écran de consentement, ou ne l'a pas encore accordée. */
export class MissingScopeError extends Error {}

/** Google demande de ralentir, ou a répondu par une erreur passagère : à retenter après une attente. */
export class RetryLaterError extends Error {}

/** L'élément n'existe plus sur le compte. */
export class NotFoundError extends Error {}

export type OnRefresh = (tokens: GoogleTokens) => void;

export interface GoogleGateway {
  authUrl(options: { state: string; codeChallenge: string; forceConsent: boolean }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<{ tokens: GoogleTokens; profile: GoogleProfile }>;
  revoke(tokens: GoogleTokens): Promise<void>;
  storageQuota(tokens: GoogleTokens, onRefresh: OnRefresh): Promise<RawStorageQuota>;
  gmail(tokens: GoogleTokens, onRefresh: OnRefresh): GmailApi;
  drive(tokens: GoogleTokens, onRefresh: OnRefresh): DriveApi;
}

export const hasScope = (tokens: GoogleTokens | null, scope: string) => Boolean(tokens?.scope?.split(' ').includes(scope));
/** L'accès complet à Gmail vaut aussi pour la lecture. */
export const canReadGmail = (tokens: GoogleTokens | null) => hasScope(tokens, GMAIL_READ_SCOPE) || hasScope(tokens, GMAIL_FULL_SCOPE);
export const canWriteGmail = (tokens: GoogleTokens | null) => hasScope(tokens, GMAIL_FULL_SCOPE);
export const canReadDrive = (tokens: GoogleTokens | null) => hasScope(tokens, DRIVE_METADATA_SCOPE) || hasScope(tokens, DRIVE_FULL_SCOPE);
export const canWriteDrive = (tokens: GoogleTokens | null) => hasScope(tokens, DRIVE_FULL_SCOPE);

// Structure des pièces jointes sans leur contenu : les parties s'emboîtent, on descend à une profondeur fixe.
const PART_FIELDS = (depth: number): string =>
  `mimeType,filename,body(size,attachmentId)${depth > 0 ? `,parts(${PART_FIELDS(depth - 1)})` : ''}`;
const MESSAGE_FIELDS = (detail: boolean) =>
  `id,threadId,labelIds,sizeEstimate,internalDate,payload(headers${detail ? `,${PART_FIELDS(6)}` : ''})`;
const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'List-Id', 'List-Unsubscribe'];

function messageQuery(detail: boolean, wrap: (fields: string) => string): string {
  const params = new URLSearchParams({ format: detail ? 'full' : 'metadata', fields: wrap(MESSAGE_FIELDS(detail)) });
  if (!detail) for (const header of METADATA_HEADERS) params.append('metadataHeaders', header);
  return params.toString();
}

export function createGoogleGateway(config: Config): GoogleGateway | null {
  const credentials = config.google;
  if (!credentials) return null;

  const newClient = () => new OAuth2Client({ ...credentials, redirectUri: config.redirectUri });

  /** Client authentifié qui enregistre les jetons renouvelés et traduit les erreurs de Google. */
  const session = (tokens: GoogleTokens, onRefresh: OnRefresh, authorized: boolean) => {
    if (!authorized) throw new MissingScopeError('Autorisation Google absente pour cette lecture');
    const client = newClient();
    client.setCredentials(tokens);
    client.on('tokens', (fresh) =>
      onRefresh({
        refresh_token: fresh.refresh_token ?? tokens.refresh_token,
        access_token: fresh.access_token,
        expiry_date: fresh.expiry_date,
        scope: fresh.scope ?? tokens.scope,
      }),
    );
    return async <T>(url: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET', data?: object): Promise<T> => {
      try {
        return (await client.request<T>({ url, method, data, retry: false })).data;
      } catch (error) {
        throw translateError(error);
      }
    };
  };

  return {
    authUrl({ state, codeChallenge, forceConsent }) {
      return newClient().generateAuthUrl({
        access_type: 'offline',
        scope: SCOPES,
        state,
        code_challenge: codeChallenge,
        code_challenge_method: CodeChallengeMethod.S256,
        include_granted_scopes: true,
        // Google ne renvoie un jeton de rafraîchissement qu'après un consentement explicite.
        prompt: forceConsent ? 'consent select_account' : 'select_account',
      });
    },

    async exchangeCode(code, codeVerifier) {
      const client = newClient();
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.id_token) throw new Error("Google n'a pas renvoyé de jeton d'identité");
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: credentials.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub || !payload.email) throw new Error("Jeton d'identité Google incomplet");
      return {
        tokens: {
          refresh_token: tokens.refresh_token,
          access_token: tokens.access_token,
          expiry_date: tokens.expiry_date,
          scope: tokens.scope,
        },
        profile: {
          sub: payload.sub,
          email: payload.email,
          emailVerified: payload.email_verified === true,
          name: payload.name,
          picture: payload.picture,
        },
      };
    },

    async revoke(tokens) {
      const token = tokens.refresh_token ?? tokens.access_token;
      if (token) await newClient().revokeToken(token);
    },

    async storageQuota(tokens, onRefresh) {
      const get = session(tokens, onRefresh, canReadDrive(tokens));
      const about = await get<{ storageQuota?: RawStorageQuota }>(`${DRIVE}/about?fields=storageQuota`);
      return about.storageQuota ?? {};
    },

    drive(tokens, onRefresh) {
      const get = session(tokens, onRefresh, canReadDrive(tokens));
      const write = async (id: string, method: 'PATCH' | 'DELETE', data?: object): Promise<void> => {
        if (!canWriteDrive(tokens)) throw new MissingScopeError('Modification de Drive non autorisée');
        await get(`${DRIVE}/files/${encodeURIComponent(id)}`, method, data);
      };
      return {
        async rootId() {
          return (await get<{ id: string }>(`${DRIVE}/files/root?fields=id`)).id;
        },
        async listFiles(pageToken) {
          const params = new URLSearchParams({
            // Seuls vos propres fichiers libèrent de la place ; les dossiers des autres ne servent qu'à nommer les chemins.
            q: `'me' in owners or mimeType = '${DRIVE_FOLDER}'`,
            pageSize: '1000',
            spaces: 'drive',
            corpora: 'user',
            fields:
              'nextPageToken,files(id,name,mimeType,quotaBytesUsed,parents,trashed,modifiedTime,shared,starred,ownedByMe,webViewLink)',
          });
          if (pageToken) params.set('pageToken', pageToken);
          const page = await get<{ files?: RawDriveFile[]; nextPageToken?: string }>(`${DRIVE}/files?${params}`);
          return { files: page.files ?? [], nextPageToken: page.nextPageToken };
        },
        trashFile: (id) => write(id, 'PATCH', { trashed: true }),
        untrashFile: (id) => write(id, 'PATCH', { trashed: false }),
        deleteFile: (id) => write(id, 'DELETE'),
      };
    },

    gmail(tokens, onRefresh) {
      const get = session(tokens, onRefresh, canReadGmail(tokens));
      const write = async (url: string, method: 'POST' | 'DELETE', data?: object): Promise<void> => {
        if (!canWriteGmail(tokens)) throw new MissingScopeError('Modification de Gmail non autorisée');
        await get(url, method, data);
      };
      const message = (id: string) => `${GMAIL}/messages/${encodeURIComponent(id)}`;
      return {
        trashMessage: (id) => write(`${message(id)}/trash`, 'POST'),
        untrashMessage: (id) => write(`${message(id)}/untrash`, 'POST'),
        deleteMessage: (id) => write(message(id), 'DELETE'),
        batchDelete: (ids) => write(`${GMAIL}/messages/batchDelete`, 'POST', { ids }),
        batchModify: (ids, { add = [], remove = [] }) =>
          write(`${GMAIL}/messages/batchModify`, 'POST', { ids, addLabelIds: add, removeLabelIds: remove }),

        async profile() {
          const profile = await get<{ messagesTotal?: number; threadsTotal?: number }>(`${GMAIL}/profile`);
          return { messagesTotal: profile.messagesTotal ?? 0, threadsTotal: profile.threadsTotal ?? 0 };
        },
        async labels() {
          const { labels = [] } = await get<{ labels?: { id: string; name: string; type?: string }[] }>(`${GMAIL}/labels`);
          return labels.map((label) => ({ id: label.id, name: label.name, type: label.type ?? 'user' }));
        },
        async listThreads({ labelId, query, pageToken }) {
          const params = new URLSearchParams({
            maxResults: '500',
            includeSpamTrash: 'true',
            fields: 'threads(id,historyId),nextPageToken',
          });
          if (labelId) params.set('labelIds', labelId);
          if (query) params.set('q', query);
          if (pageToken) params.set('pageToken', pageToken);
          const page = await get<{ threads?: { id: string; historyId: string }[]; nextPageToken?: string }>(
            `${GMAIL}/threads?${params}`,
          );
          return { threads: page.threads ?? [], nextPageToken: page.nextPageToken };
        },
        async getThread(id, detail) {
          const thread = await get<{ messages?: RawGmailMessage[] }>(
            `${GMAIL}/threads/${encodeURIComponent(id)}?${messageQuery(detail, (fields) => `messages(${fields})`)}`,
          );
          return thread.messages ?? [];
        },
        getMessage(id) {
          return get<RawGmailMessage>(`${GMAIL}/messages/${encodeURIComponent(id)}?${messageQuery(true, (fields) => fields)}`);
        },
      };
    },
  };
}

interface GoogleErrorBody {
  error?: string | { status?: string; message?: string; errors?: { reason?: string }[] };
}

function translateError(error: unknown): unknown {
  const response = (error as { response?: { status?: number; data?: GoogleErrorBody } }).response;
  if (!response) return new RetryLaterError('Google est injoignable', { cause: error });
  const { status, data } = response;
  const detail = typeof data?.error === 'object' ? data.error : undefined;
  const reason = `${detail?.errors?.[0]?.reason ?? ''} ${detail?.status ?? ''} ${detail?.message ?? ''}`;
  if (status === 401 || data?.error === 'invalid_grant') return new ReauthRequiredError('Autorisation Google expirée ou révoquée');
  if (status === 429 || (status === 403 && /rateLimit|quota|RESOURCE_EXHAUSTED/i.test(reason))) {
    return new RetryLaterError('Google demande de ralentir');
  }
  // À ne pas confondre avec un refus sur un fichier précis (insufficientFilePermissions), qui n'est pas une affaire d'autorisation.
  if (status === 403 && /insufficientPermissions|SCOPE_INSUFFICIENT|authentication scopes/i.test(reason)) {
    return new MissingScopeError('Autorisation Google insuffisante');
  }
  if (status === 404) return new NotFoundError('Élément introuvable');
  if (status !== undefined && status >= 500) return new RetryLaterError(`Google a répondu ${status}`);
  return error;
}

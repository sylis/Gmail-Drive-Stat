import { CodeChallengeMethod, OAuth2Client } from 'google-auth-library';
import type { Config } from './config.js';

// Lot 1 : identité + lecture du quota. Les accès Gmail et Drive complets seront demandés par les lots suivants.
const DRIVE_METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';
export const SCOPES = ['openid', 'email', 'profile', DRIVE_METADATA_SCOPE];

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

/** Google a retiré l'autorisation (expiration du mode test, révocation) : l'utilisateur doit se reconnecter. */
export class ReauthRequiredError extends Error {}

/** L'utilisateur a décoché une autorisation nécessaire sur l'écran de consentement. */
export class MissingScopeError extends Error {}

export interface GoogleGateway {
  authUrl(options: { state: string; codeChallenge: string; forceConsent: boolean }): string;
  exchangeCode(code: string, codeVerifier: string): Promise<{ tokens: GoogleTokens; profile: GoogleProfile }>;
  revoke(tokens: GoogleTokens): Promise<void>;
  storageQuota(tokens: GoogleTokens, onRefresh: (tokens: GoogleTokens) => void): Promise<RawStorageQuota>;
}

export function createGoogleGateway(config: Config): GoogleGateway | null {
  const credentials = config.google;
  if (!credentials) return null;

  const newClient = () => new OAuth2Client({ ...credentials, redirectUri: config.redirectUri });

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
      if (!tokens.scope?.split(' ').includes(DRIVE_METADATA_SCOPE)) {
        throw new MissingScopeError("La lecture du quota Drive n'a pas été autorisée");
      }
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
      try {
        const response = await client.request<{ storageQuota?: RawStorageQuota }>({
          url: 'https://www.googleapis.com/drive/v3/about',
          params: { fields: 'storageQuota' },
        });
        return response.data.storageQuota ?? {};
      } catch (error) {
        if (isAuthFailure(error)) throw new ReauthRequiredError('Autorisation Google expirée ou révoquée');
        throw error;
      }
    },
  };
}

function isAuthFailure(error: unknown): boolean {
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } }).response;
  return response?.status === 401 || response?.data?.error === 'invalid_grant';
}

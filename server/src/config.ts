export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  port: number;
  databasePath: string;
  /** Origine publique du serveur, sans barre finale (ex. http://serveur.local:8080). */
  publicUrl: string;
  redirectUri: string;
  secureCookies: boolean;
  encryptionKey: string;
  allowedEmails: ReadonlySet<string>;
  /** null tant que l'installateur n'a pas créé son accès Google : l'interface affiche alors le guide. */
  google: GoogleCredentials | null;
}

export class ConfigError extends Error {}

export const OAUTH_CALLBACK_PATH = '/auth/callback';
const MIN_KEY_LENGTH = 32;

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const read = (name: string) => env[name]?.trim() || undefined;
  const required = (name: string, role: string) => {
    const value = read(name);
    if (!value) problems.push(`${name} est manquante (${role})`);
    return value ?? '';
  };

  const rawPublicUrl = required('PUBLIC_URL', 'adresse publique du serveur, ex. http://localhost:8080');
  let publicUrl = '';
  let secureCookies = false;
  if (rawPublicUrl) {
    try {
      const url = new URL(rawPublicUrl);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocole');
      publicUrl = url.origin;
      secureCookies = url.protocol === 'https:';
    } catch {
      problems.push('PUBLIC_URL doit être une adresse http:// ou https:// valide');
    }
  }

  const encryptionKey = required('ENCRYPTION_KEY', 'clé de chiffrement des jetons Google');
  if (encryptionKey && encryptionKey.length < MIN_KEY_LENGTH) {
    problems.push(`ENCRYPTION_KEY doit contenir au moins ${MIN_KEY_LENGTH} caractères (ex. openssl rand -base64 32)`);
  }

  const allowedEmails = new Set(
    required('ALLOWED_EMAILS', 'adresses Google autorisées, séparées par des virgules')
      .split(/[,;\s]+/)
      .map((email) => email.toLowerCase())
      .filter(Boolean),
  );
  for (const email of allowedEmails) {
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) problems.push(`ALLOWED_EMAILS contient une adresse invalide : ${email}`);
  }

  const clientId = read('GOOGLE_CLIENT_ID');
  const clientSecret = read('GOOGLE_CLIENT_SECRET');
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    problems.push('GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET doivent être renseignées ensemble');
  }

  const port = Number(read('PORT') ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('PORT doit être un numéro de port valide');

  if (problems.length > 0) {
    throw new ConfigError(`Configuration invalide :\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return {
    port,
    databasePath: read('DATABASE_PATH') ?? './data/gmailstat.sqlite',
    publicUrl,
    redirectUri: publicUrl + OAUTH_CALLBACK_PATH,
    secureCookies,
    encryptionKey,
    allowedEmails,
    google: clientId && clientSecret ? { clientId, clientSecret } : null,
  };
}

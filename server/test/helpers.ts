import { FakeGoogle } from '../dev/fake-google.ts';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { DriveCleaner } from '../src/drive/cleaner.ts';
import { DriveScanner } from '../src/drive/scanner.ts';
import { DriveStore } from '../src/drive/store.ts';
import { GmailCleaner } from '../src/gmail/cleaner.ts';
import { GmailScanner } from '../src/gmail/scanner.ts';
import { GmailStore } from '../src/gmail/store.ts';
import { Store } from '../src/store.ts';

export const ENV = {
  PUBLIC_URL: 'http://localhost:8080/',
  ENCRYPTION_KEY: 'cle-de-test-suffisamment-longue-0123456789',
  ALLOWED_EMAILS: 'Moi@Example.com, autre@example.com',
  GOOGLE_CLIENT_ID: 'id-de-test',
  GOOGLE_CLIENT_SECRET: 'secret-de-test',
};

const ORIGIN = 'http://localhost:8080';

/** Monte le serveur sur une base en mémoire et un faux compte Google. */
export async function setup() {
  const config = loadConfig(ENV);
  const db = openDatabase(':memory:');
  const store = new Store(db, new SecretBox(config.encryptionKey));
  const fake = new FakeGoogle();
  const gmail = new GmailStore(db);
  // Débit non bridé et attentes courtes : les tests n'ont pas à patienter comme face à Google.
  const scanner = new GmailScanner(store, gmail, fake, { unitsPerSecond: 1e9, backoff: () => 5 });
  const cleaner = new GmailCleaner(store, gmail, fake, { unitsPerSecond: 1e9, backoff: () => 5 });
  const fast = { unitsPerSecond: 1e9, backoff: () => 5 };
  const drive = new DriveStore(db);
  const driveScanner = new DriveScanner(store, drive, fake, fast);
  const driveCleaner = new DriveCleaner(store, drive, fake, fast);
  const app = await buildApp({ config, store, gmail, scanner, cleaner, drive, driveScanner, driveCleaner, google: fake, logger: false });

  /** Joue l'aller-retour Google et renvoie les cookies posés par le serveur. */
  const login = async (): Promise<Record<string, string>> => {
    const start = await app.inject({ url: '/auth/google' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const callback = await app.inject({
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { gds_oauth_state: state },
    });
    return Object.fromEntries(callback.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  };

  /** Envoie une action comme le fait l'interface (même origine, corps JSON). */
  const post = (url: string, cookies: Record<string, string>, body: object = {}) =>
    app.inject({ method: 'POST', url, cookies, headers: { origin: ORIGIN }, payload: body });

  return { app, db, store, gmail, scanner, cleaner, drive, driveScanner, driveCleaner, fake, login, post };
}

/** Attend qu'une condition devienne vraie, sans dépendre de la vitesse de la machine. */
export async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error('condition jamais remplie');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

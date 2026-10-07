// Mode démonstration : le serveur complet sur un faux compte Google et une boîte fictive, sans rien d'installé chez Google.
// Lancement : npm run demo, puis ouvrir http://localhost:8090 (l'interface doit avoir été compilée : npm run build:web).
import { resolve } from 'node:path';
import { buildApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { GmailCleaner } from '../src/gmail/cleaner.ts';
import { GmailScanner } from '../src/gmail/scanner.ts';
import { GmailStore } from '../src/gmail/store.ts';
import { Store } from '../src/store.ts';
import { FakeGoogle, seedMailbox } from './fake-google.ts';

const port = Number(process.env.DEMO_PORT ?? 8090);
const config = loadConfig({
  PUBLIC_URL: `http://localhost:${port}`,
  ENCRYPTION_KEY: 'cle-de-demonstration-sans-valeur-0123456789',
  ALLOWED_EMAILS: 'moi@example.com',
  GOOGLE_CLIENT_ID: 'demo',
  GOOGLE_CLIENT_SECRET: 'demo',
  PORT: String(port),
});

const fake = new FakeGoogle();
seedMailbox(fake, Number(process.env.DEMO_THREADS ?? 3000));
fake.latencyMs = Number(process.env.DEMO_LATENCY ?? 15);
// Pas d'écran Google : la « connexion » revient aussitôt sur le serveur.
fake.authUrl = ({ state }) => `/auth/callback?code=demo&state=${state}`;
const mailbox = [...fake.threads.values()].flatMap((thread) => thread.messages).reduce((sum, message) => sum + (message.sizeEstimate ?? 0), 0);
const GB = 1024 ** 3;
fake.quota = { limit: String((mailbox > 10 * GB ? 100 : 15) * GB), usage: String(Math.round(mailbox + 3.1 * GB)), usageInDrive: String(2.4 * GB), usageInDriveTrash: String(0.3 * GB) };

const db = openDatabase(':memory:');
const store = new Store(db, new SecretBox(config.encryptionKey));
const gmail = new GmailStore(db);
// Rien à ménager côté Google : le scan de démonstration va plus vite que le vrai.
const scanner = new GmailScanner(store, gmail, fake, { unitsPerSecond: Number(process.env.DEMO_RATE ?? 1500) });
const cleaner = new GmailCleaner(store, gmail, fake, { unitsPerSecond: Number(process.env.DEMO_RATE ?? 1500) });
const app = await buildApp({ config, store, gmail, scanner, cleaner, google: fake, webRoot: resolve(import.meta.dirname, '../../dist/web') });
await app.listen({ port, host: '127.0.0.1' });

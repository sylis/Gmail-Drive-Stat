// Mode démonstration : le serveur complet sur un faux compte Google et une boîte fictive, sans rien d'installé chez Google.
// Lancement : npm run demo, puis ouvrir http://localhost:8090 (l'interface doit avoir été compilée : npm run build:web).
import { resolve } from 'node:path';
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
import { FakeGoogle, seedDrive, seedMailbox } from './fake-google.ts';

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
seedDrive(fake, Number(process.env.DEMO_FILES ?? 2500));
const mailbox = [...fake.threads.values()].flatMap((thread) => thread.messages).reduce((sum, message) => sum + (message.sizeEstimate ?? 0), 0);
const GB = 1024 ** 3;
const driveFiles = [...fake.files.values()];
const driveBytes = (trashed: boolean) => driveFiles.filter((file) => Boolean(file.trashed) === trashed).reduce((sum, file) => sum + Number(file.quotaBytesUsed ?? 0), 0);
const usage = mailbox + driveBytes(false) + driveBytes(true) + 3.1 * GB;
fake.quota = {
  limit: String((usage > 13 * GB ? (usage > 90 * GB ? 200 : 100) : 15) * GB),
  usage: String(Math.round(usage)),
  usageInDrive: String(driveBytes(false) + driveBytes(true)),
  usageInDriveTrash: String(driveBytes(true)),
};

const db = openDatabase(':memory:');
const store = new Store(db, new SecretBox(config.encryptionKey));
const gmail = new GmailStore(db);
// Rien à ménager côté Google : le scan de démonstration va plus vite que le vrai.
const scanner = new GmailScanner(store, gmail, fake, { unitsPerSecond: Number(process.env.DEMO_RATE ?? 1500) });
const cleaner = new GmailCleaner(store, gmail, fake, { unitsPerSecond: Number(process.env.DEMO_RATE ?? 1500) });
const drive = new DriveStore(db);
const driveScanner = new DriveScanner(store, drive, fake);
const driveCleaner = new DriveCleaner(store, drive, fake, { unitsPerSecond: Number(process.env.DEMO_RATE ?? 1500) });
const app = await buildApp({ config, store, gmail, scanner, cleaner, drive, driveScanner, driveCleaner, google: fake, webRoot: resolve(import.meta.dirname, '../../dist/web') });
await app.listen({ port, host: '127.0.0.1' });

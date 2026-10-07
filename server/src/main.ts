import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApp } from './app.js';
import { ConfigError, loadConfig } from './config.js';
import { SecretBox } from './crypto.js';
import { openDatabase } from './db.js';
import { createGoogleGateway } from './google.js';
import { Store } from './store.js';

function findWebRoot(): string | undefined {
  // Compilé : dist/server/main.js à côté de dist/web ; en développement : server/src/main.ts.
  const candidates = [resolve(import.meta.dirname, '../web'), resolve(import.meta.dirname, '../../dist/web')];
  return candidates.find((dir) => existsSync(resolve(dir, 'index.html')));
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(`${error.message}\n\nRenseignez ces variables dans le fichier .env (modèle : .env.example), puis relancez.`);
    process.exit(1);
  }

  const db = openDatabase(config.databasePath);
  const store = new Store(db, new SecretBox(config.encryptionKey));
  const google = createGoogleGateway(config);
  const app = await buildApp({ config, store, google, webRoot: findWebRoot() });

  if (!google) {
    app.log.warn('GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET absents : l\'interface affiche le guide de première installation.');
  }
  app.log.info(`Adresse de retour à déclarer chez Google : ${config.redirectUri}`);

  const shutdown = async () => {
    await app.close();
    db.close();
    process.exit(0);
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  await app.listen({ port: config.port, host: '0.0.0.0' });
}

await main();

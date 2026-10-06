import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildApp } from '../src/app.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { SecretBox } from '../src/crypto.ts';
import { openDatabase } from '../src/db.ts';
import { ReauthRequiredError, type GoogleGateway, type GoogleProfile, type GoogleTokens } from '../src/google.ts';
import { breakdownQuota } from '../src/quota.ts';
import { Store } from '../src/store.ts';

const ENV = {
  PUBLIC_URL: 'http://localhost:8080/',
  ENCRYPTION_KEY: 'cle-de-test-suffisamment-longue-0123456789',
  ALLOWED_EMAILS: 'Moi@Example.com, autre@example.com',
  GOOGLE_CLIENT_ID: 'id-de-test',
  GOOGLE_CLIENT_SECRET: 'secret-de-test',
};

test('la configuration nomme chaque variable manquante', () => {
  assert.throws(
    () => loadConfig({}),
    (error: unknown) =>
      error instanceof ConfigError && ['PUBLIC_URL', 'ENCRYPTION_KEY', 'ALLOWED_EMAILS'].every((name) => error.message.includes(name)),
  );
  assert.throws(() => loadConfig({ ...ENV, ENCRYPTION_KEY: 'trop-courte' }), /ENCRYPTION_KEY/);
  assert.throws(() => loadConfig({ ...ENV, GOOGLE_CLIENT_SECRET: '' }), /GOOGLE_CLIENT_ID et GOOGLE_CLIENT_SECRET/);
});

test('la configuration normalise l’adresse publique et les adresses autorisées', () => {
  const config = loadConfig(ENV);
  assert.equal(config.redirectUri, 'http://localhost:8080/auth/callback');
  assert.equal(config.secureCookies, false);
  assert.deepEqual([...config.allowedEmails], ['moi@example.com', 'autre@example.com']);
  assert.equal(loadConfig({ ...ENV, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' }).google, null);
});

test('le chiffrement des jetons est réversible et lié à la clé', () => {
  const box = new SecretBox(ENV.ENCRYPTION_KEY);
  const encrypted = box.encrypt('jeton-secret');
  assert.ok(!encrypted.includes('jeton-secret'));
  assert.equal(box.decrypt(encrypted), 'jeton-secret');
  assert.throws(() => new SecretBox(`${ENV.ENCRYPTION_KEY}-autre`).decrypt(encrypted));
});

test('la répartition du quota retombe sur le total', () => {
  const quota = breakdownQuota({ limit: '1000', usage: '700', usageInDrive: '300', usageInDriveTrash: '50' });
  assert.deepEqual(
    quota.parts.map((part) => [part.key, part.bytes]),
    [['gmailPhotos', 400], ['drive', 250], ['driveTrash', 50], ['free', 300]],
  );
  assert.equal(breakdownQuota({ usage: '10' }).limit, null);
});

interface Fake {
  profile: GoogleProfile;
  tokens: GoogleTokens;
  revoked: number;
  quotaFails: boolean;
}

async function setup() {
  const config = loadConfig(ENV);
  const store = new Store(openDatabase(':memory:'), new SecretBox(config.encryptionKey));
  const fake: Fake = {
    profile: { sub: 'sub-1', email: 'moi@example.com', emailVerified: true, name: 'Moi' },
    tokens: { refresh_token: 'rt', access_token: 'at', scope: 'openid' },
    revoked: 0,
    quotaFails: false,
  };
  const google: GoogleGateway = {
    authUrl: ({ state, forceConsent }) => `https://google.test/auth?state=${state}&consent=${forceConsent}`,
    exchangeCode: async () => ({ tokens: fake.tokens, profile: fake.profile }),
    revoke: async () => void fake.revoked++,
    storageQuota: async () => {
      if (fake.quotaFails) throw new ReauthRequiredError('expirée');
      return { limit: '100', usage: '40', usageInDrive: '10', usageInDriveTrash: '0' };
    },
  };
  const app = await buildApp({ config, store, google, logger: false });

  /** Joue l'aller-retour Google et renvoie les cookies posés par le serveur. */
  const login = async () => {
    const start = await app.inject({ url: '/auth/google' });
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const callback = await app.inject({
      url: `/auth/callback?code=abc&state=${state}`,
      cookies: { gds_oauth_state: state },
    });
    return Object.fromEntries(callback.cookies.filter((c) => c.value).map((c) => [c.name, c.value]));
  };
  return { app, fake, login };
}

test('une adresse autorisée ouvre une session et lit son quota', async () => {
  const { app, login } = await setup();
  const cookies = await login();
  assert.ok(cookies.gds_session);

  const status = (await app.inject({ url: '/api/status', cookies })).json();
  assert.equal(status.user.email, 'moi@example.com');
  assert.equal(status.configured, true);

  const quota = await app.inject({ url: '/api/quota', cookies });
  assert.equal(quota.statusCode, 200);
  assert.equal(quota.json().usage, 40);
});

test('une adresse non autorisée est refusée et son autorisation retirée', async () => {
  const { app, fake, login } = await setup();
  fake.profile = { ...fake.profile, email: 'intrus@example.com' };
  const cookies = await login();
  assert.equal(cookies.gds_session, undefined);
  assert.equal(fake.revoked, 1);

  const status = (await app.inject({ url: '/api/status', cookies })).json();
  assert.equal(status.user, null);
  assert.deepEqual(status.flash, { kind: 'refuse', email: 'intrus@example.com' });
});

test('une adresse non vérifiée par Google est refusée', async () => {
  const { fake, login } = await setup();
  fake.profile = { ...fake.profile, emailVerified: false };
  assert.equal((await login()).gds_session, undefined);
});

test('le retour de Google est rejeté si l’état ne correspond pas au navigateur', async () => {
  const { app } = await setup();
  const start = await app.inject({ url: '/auth/google' });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const forged = await app.inject({ url: `/auth/callback?code=abc&state=${state}`, cookies: { gds_oauth_state: 'autre' } });
  assert.ok(!forged.cookies.some((c) => c.name === 'gds_session' && c.value));

  // Un état valide ne sert qu'une fois.
  const first = await app.inject({ url: `/auth/callback?code=abc&state=${state}`, cookies: { gds_oauth_state: state } });
  assert.ok(first.cookies.some((c) => c.name === 'gds_session' && c.value));
  const replay = await app.inject({ url: `/auth/callback?code=abc&state=${state}`, cookies: { gds_oauth_state: state } });
  assert.ok(!replay.cookies.some((c) => c.name === 'gds_session' && c.value));
});

test('sans jeton de rafraîchissement, le consentement est redemandé', async () => {
  const { app, fake } = await setup();
  fake.tokens = { access_token: 'at' };
  const start = await app.inject({ url: '/auth/google' });
  const state = new URL(start.headers.location as string).searchParams.get('state')!;
  const callback = await app.inject({ url: `/auth/callback?code=abc&state=${state}`, cookies: { gds_oauth_state: state } });
  assert.equal(callback.headers.location, '/auth/google?consent=1');
});

test('l’API exige une session et les actions exigent la bonne origine', async () => {
  const { app, login } = await setup();
  assert.equal((await app.inject({ url: '/api/quota' })).statusCode, 401);
  const cookies = await login();

  const foreign = await app.inject({ method: 'POST', url: '/auth/logout', cookies, headers: { origin: 'http://ailleurs.test' } });
  assert.equal(foreign.statusCode, 403);
  assert.equal((await app.inject({ url: '/api/quota', cookies })).statusCode, 200);

  const logout = await app.inject({ method: 'POST', url: '/auth/logout', cookies, headers: { origin: 'http://localhost:8080' } });
  assert.equal(logout.statusCode, 200);
  assert.equal((await app.inject({ url: '/api/quota', cookies })).statusCode, 401);
});

test('une autorisation expirée demande une reconnexion sans fermer la session', async () => {
  const { app, fake, login } = await setup();
  const cookies = await login();
  fake.quotaFails = true;
  const quota = await app.inject({ url: '/api/quota', cookies });
  assert.equal(quota.statusCode, 401);
  assert.equal(quota.json().error, 'reconnexion-requise');
  const status = (await app.inject({ url: '/api/status', cookies })).json();
  assert.equal(status.needsReauth, true);
  assert.equal(status.user.email, 'moi@example.com');
});

test('la révocation efface le compte et retire l’autorisation Google', async () => {
  const { app, fake, login } = await setup();
  const cookies = await login();
  const revoke = await app.inject({ method: 'POST', url: '/api/account/revoke', cookies, headers: { origin: 'http://localhost:8080' } });
  assert.deepEqual(revoke.json(), { ok: true, revokedAtGoogle: true });
  assert.equal(fake.revoked, 1);
  assert.equal((await app.inject({ url: '/api/status', cookies })).json().user, null);
});

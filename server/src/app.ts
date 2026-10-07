import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { OAUTH_CALLBACK_PATH, type Config } from './config.js';
import type { DriveCleaner } from './drive/cleaner.js';
import { registerDriveRoutes } from './drive/routes.js';
import type { DriveScanner } from './drive/scanner.js';
import type { DriveStore } from './drive/store.js';
import type { GmailCleaner } from './gmail/cleaner.js';
import { registerGmailRoutes } from './gmail/routes.js';
import type { GmailScanner } from './gmail/scanner.js';
import type { GmailStore } from './gmail/store.js';
import { MissingScopeError, ReauthRequiredError, type GoogleGateway } from './google.js';
import { breakdownQuota } from './quota.js';
import type { Account, Store } from './store.js';

const SESSION_COOKIE = 'gds_session';
const OAUTH_STATE_COOKIE = 'gds_oauth_state';
const CONSENT_RETRY_COOKIE = 'gds_consent_retry';
const FLASH_COOKIE = 'gds_flash';

/** Message affiché une seule fois sur l'écran de connexion après un retour de Google. */
type Flash = { kind: 'refuse'; email: string } | { kind: 'annule' } | { kind: 'echec' };

export interface AppDeps {
  config: Config;
  store: Store;
  gmail: GmailStore;
  scanner: GmailScanner;
  cleaner: GmailCleaner;
  drive: DriveStore;
  driveScanner: DriveScanner;
  driveCleaner: DriveCleaner;
  google: GoogleGateway | null;
  /** Dossier de l'interface compilée ; absent en développement, où Vite la sert. */
  webRoot?: string;
  logger?: boolean;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  // Le retour de Google porte un code à usage unique dans l'URL : on ne journalise que le chemin.
  const { config, store, gmail, scanner, cleaner, drive, driveScanner, driveCleaner, google, webRoot, logger = true } = deps;
  const serializers = { req: (req: { method: string; url: string }) => ({ method: req.method, path: req.url.split('?')[0] }) };
  const app: FastifyInstance = Fastify({ logger: logger ? { serializers } : false });
  await app.register(cookie);

  const cookieOptions = { path: '/', httpOnly: true, sameSite: 'lax', secure: config.secureCookies } as const;

  app.addHook('onRequest', async (request, reply) => {
    reply.headers({
      'Content-Security-Policy':
        "default-src 'self'; img-src 'self' data: https://*.googleusercontent.com; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
    });
    // Les actions (déconnexion, révocation) ne sont acceptées que depuis l'interface elle-même.
    if (request.method !== 'GET' && request.method !== 'HEAD' && request.headers.origin !== config.publicUrl) {
      return reply.code(403).send({ error: 'origine-refusee' });
    }
  });

  const currentAccount = (request: FastifyRequest): Account | null => {
    const sessionId = request.cookies[SESSION_COOKIE];
    return sessionId ? store.findAccountBySession(sessionId) : null;
  };

  const requireAccount = (request: FastifyRequest, reply: FastifyReply): Account | null => {
    const account = currentAccount(request);
    if (!account) void reply.code(401).send({ error: 'non-connecte' });
    return account;
  };

  const setFlash = (reply: FastifyReply, flash: Flash) =>
    reply.setCookie(FLASH_COOKIE, Buffer.from(JSON.stringify(flash)).toString('base64url'), { ...cookieOptions, maxAge: 60 });

  const takeFlash = (request: FastifyRequest, reply: FastifyReply): Flash | null => {
    const raw = request.cookies[FLASH_COOKIE];
    if (!raw) return null;
    reply.clearCookie(FLASH_COOKIE, cookieOptions);
    try {
      return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) as Flash;
    } catch {
      return null;
    }
  };

  app.get('/api/health', async () => ({ ok: true }));

  app.get('/api/status', async (request, reply) => {
    const account = currentAccount(request);
    reply.header('Cache-Control', 'no-store');
    return {
      configured: google !== null,
      redirectUri: config.redirectUri,
      user: account && { email: account.email, name: account.name, picture: account.picture },
      needsReauth: account?.needsReauth ?? false,
      flash: takeFlash(request, reply),
    };
  });

  app.get<{ Querystring: { consent?: string } }>('/auth/google', async (request, reply) => {
    if (!google) return reply.redirect('/');
    const { state, codeVerifier } = store.createOAuthState();
    reply.setCookie(OAUTH_STATE_COOKIE, state, { ...cookieOptions, maxAge: 600 });
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');
    return reply.redirect(google.authUrl({ state, codeChallenge, forceConsent: request.query.consent === '1' }));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    OAUTH_CALLBACK_PATH,
    async (request, reply) => {
      if (!google) return reply.redirect('/');
      const { code, state, error } = request.query;
      const expectedState = request.cookies[OAUTH_STATE_COOKIE];
      const alreadyRetried = request.cookies[CONSENT_RETRY_COOKIE] === '1';
      reply.clearCookie(OAUTH_STATE_COOKIE, cookieOptions).clearCookie(CONSENT_RETRY_COOKIE, cookieOptions);

      if (error) return setFlash(reply, { kind: 'annule' }).redirect('/');
      const codeVerifier = state && state === expectedState ? store.consumeOAuthState(state) : null;
      if (!code || !codeVerifier) return setFlash(reply, { kind: 'echec' }).redirect('/');

      let exchanged;
      try {
        exchanged = await google.exchangeCode(code, codeVerifier);
      } catch (cause) {
        request.log.warn({ err: cause }, 'Échange du code Google refusé');
        return setFlash(reply, { kind: 'echec' }).redirect('/');
      }
      const { tokens, profile } = exchanged;

      if (!profile.emailVerified || !config.allowedEmails.has(profile.email.toLowerCase())) {
        request.log.warn({ email: profile.email }, 'Connexion refusée : adresse non autorisée');
        await google.revoke(tokens).catch(() => undefined);
        return setFlash(reply, { kind: 'refuse', email: profile.email }).redirect('/');
      }

      // Sans jeton de rafraîchissement, l'accès ne survivrait pas à l'heure : on redemande le consentement, une fois.
      if (!tokens.refresh_token && !store.hasRefreshToken(profile.sub) && !alreadyRetried) {
        return reply.setCookie(CONSENT_RETRY_COOKIE, '1', { ...cookieOptions, maxAge: 600 }).redirect('/auth/google?consent=1');
      }

      const accountId = store.upsertAccount(profile, tokens);
      // Un scan suspendu par l'expiration de l'autorisation repart dès la reconnexion.
      scanner.resume(accountId);
      cleaner.resume(accountId);
      driveScanner.resume(accountId);
      driveCleaner.resume(accountId);
      const session = store.createSession(accountId);
      return reply.setCookie(SESSION_COOKIE, session.id, { ...cookieOptions, maxAge: session.maxAgeSeconds }).redirect('/');
    },
  );

  app.post('/auth/logout', async (request, reply) => {
    const sessionId = request.cookies[SESSION_COOKIE];
    if (sessionId) store.deleteSession(sessionId);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true });
  });

  /** Retire l'autorisation côté Google et efface le compte du serveur. */
  app.post('/api/account/revoke', async (request, reply) => {
    const account = currentAccount(request);
    if (!account) return reply.code(401).send({ error: 'non-connecte' });
    const tokens = store.getTokens(account.id);
    let revokedAtGoogle = false;
    if (google && tokens) {
      revokedAtGoogle = await google.revoke(tokens).then(
        () => true,
        (cause) => {
          request.log.warn({ err: cause }, 'Révocation Google en échec');
          return false;
        },
      );
    }
    await scanner.cancel(account.id);
    await cleaner.cancel(account.id);
    await driveScanner.cancel(account.id);
    await driveCleaner.cancel(account.id);
    store.deleteAccount(account.id);
    return reply.clearCookie(SESSION_COOKIE, cookieOptions).send({ ok: true, revokedAtGoogle });
  });

  app.get('/api/quota', async (request, reply) => {
    const account = currentAccount(request);
    if (!account) return reply.code(401).send({ error: 'non-connecte' });
    const tokens = store.getTokens(account.id);
    if (!google || !tokens) {
      store.markNeedsReauth(account.id);
      return reply.code(401).send({ error: 'reconnexion-requise' });
    }
    try {
      const raw = await google.storageQuota(tokens, (fresh) => store.saveTokens(account.id, fresh));
      reply.header('Cache-Control', 'no-store');
      return breakdownQuota(raw);
    } catch (cause) {
      if (cause instanceof ReauthRequiredError) {
        store.markNeedsReauth(account.id);
        return reply.code(401).send({ error: 'reconnexion-requise' });
      }
      if (cause instanceof MissingScopeError) return reply.code(403).send({ error: 'autorisation-incomplete' });
      request.log.error({ err: cause }, 'Lecture du quota Google en échec');
      return reply.code(502).send({ error: 'google-indisponible' });
    }
  });

  registerGmailRoutes(app, { store, gmail, scanner, cleaner, google, requireAccount });
  registerDriveRoutes(app, { store, drive, scanner: driveScanner, cleaner: driveCleaner, requireAccount });

  if (webRoot && existsSync(webRoot)) {
    await app.register(fastifyStatic, { root: webRoot });
    app.setNotFoundHandler((request, reply) => {
      const isPage = request.method === 'GET' && !request.url.startsWith('/api/') && !request.url.startsWith('/auth/');
      return isPage ? reply.sendFile('index.html') : reply.code(404).send({ error: 'introuvable' });
    });
  }

  return app;
}

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canReadGmail, canWriteGmail, MissingScopeError, ReauthRequiredError, type GoogleGateway } from '../google.js';
import type { Account, Store } from '../store.js';
import { MAX_TARGETS, registerCleanupRoutes } from '../cleanup-routes.js';
import { ACTIONS, type GmailCleaner } from './cleaner.js';
import type { Zone } from './parse.js';
import { GmailQueries, isAxis, parseFilters, type Axis } from './queries.js';
import type { GmailScanner } from './scanner.js';
import { parseScope } from './scope.js';
import { isActive, type GmailStore } from './store.js';

export interface GmailDeps {
  store: Store;
  gmail: GmailStore;
  scanner: GmailScanner;
  cleaner: GmailCleaner;
  google: GoogleGateway | null;
  /** Renvoie le compte de la session, ou répond 401 et renvoie null. */
  requireAccount: (request: FastifyRequest, reply: FastifyReply) => Account | null;
}

const ZONES: Zone[] = ['inbox', 'sent', 'trash'];
const MAX_LEVELS = 5;
interface ViewBody {
  levels?: unknown;
  path?: unknown;
  filters?: unknown;
}

/** Niveaux et zoom demandés par l'interface ; null s'ils sont incohérents. */
function parseView(body: ViewBody | undefined): { levels: Axis[]; path: string[] } | null {
  const levels = body?.levels ?? [];
  const path = body?.path ?? [];
  if (!Array.isArray(levels) || levels.length > MAX_LEVELS || !levels.every(isAxis)) return null;
  if (new Set(levels).size !== levels.length) return null;
  if (!Array.isArray(path) || path.length > levels.length || !path.every((item) => typeof item === 'string')) return null;
  return { levels, path };
}

export function registerGmailRoutes(app: FastifyInstance, { store, gmail, scanner, cleaner, google, requireAccount }: GmailDeps): void {
  const queries = new GmailQueries(gmail);

  app.get('/api/gmail/state', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    reply.header('Cache-Control', 'no-store');
    return {
      authorized: canReadGmail(store.getTokens(account.id)),
      canClean: canWriteGmail(store.getTokens(account.id)),
      scan: scanner.progress(account.id),
      cleanup: cleaner.progress(account.id),
      summary: queries.summary(account.id),
      scopes: gmail.doneScopes(account.id),
      labels: gmail.labels(account.id),
    };
  });

  /** Taille de la boîte et libellés, lus chez Google : sert à préparer le choix du périmètre. */
  app.get('/api/gmail/mailbox', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const tokens = store.getTokens(account.id);
    if (!google || !tokens) {
      store.markNeedsReauth(account.id);
      return reply.code(401).send({ error: 'reconnexion-requise' });
    }
    try {
      const api = google.gmail(tokens, (fresh) => store.saveTokens(account.id, fresh));
      const [profile, labels] = await Promise.all([api.profile(), api.labels()]);
      gmail.saveLabels(account.id, labels);
      reply.header('Cache-Control', 'no-store');
      return { ...profile, labels: gmail.labels(account.id) };
    } catch (cause) {
      if (cause instanceof ReauthRequiredError) {
        store.markNeedsReauth(account.id);
        return reply.code(401).send({ error: 'reconnexion-requise' });
      }
      if (cause instanceof MissingScopeError) return reply.code(403).send({ error: 'autorisation-incomplete' });
      request.log.error({ err: cause }, 'Lecture de la boîte Gmail en échec');
      return reply.code(502).send({ error: 'google-indisponible' });
    }
  });

  app.post<{ Body: { scope?: unknown } }>('/api/gmail/scan', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const scope = parseScope(request.body?.scope);
    if (!scope) return reply.code(400).send({ error: 'perimetre-invalide' });
    // Un scan et un nettoyage ne tournent pas en même temps : ils se disputeraient le débit Gmail et la base.
    if (cleaner.active(account.id)) return reply.code(409).send({ error: 'nettoyage-en-cours' });
    if (!scanner.start(account.id, scope)) return reply.code(409).send({ error: 'scan-deja-en-cours' });
    return { scan: scanner.progress(account.id) };
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/api/gmail/scan/${action}`, async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      await scanner[action](account.id);
      return { scan: scanner.progress(account.id) };
    });
  }

  app.post<{ Body: ViewBody }>('/api/gmail/treemap', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const view = parseView(request.body);
    if (!view) return reply.code(400).send({ error: 'vue-invalide' });
    const filters = parseFilters(request.body?.filters);
    return {
      tree: queries.treemap(account.id, { ...view, filters }),
      // Les messages reçus sans le zoom : c'est à eux que se mesurent les zones Envoyés et Corbeille.
      received: queries.total(account.id, 'inbox', filters),
      sent: queries.zone(account.id, 'sent', filters),
      trash: queries.zone(account.id, 'trash', filters),
    };
  });

  app.post<{ Body: ViewBody & { zone?: unknown; sort?: unknown; descending?: unknown; offset?: unknown } }>(
    '/api/gmail/list',
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const view = parseView(request.body);
      if (!view) return reply.code(400).send({ error: 'vue-invalide' });
      const { zone = 'inbox', sort, descending, offset } = request.body;
      if (!ZONES.includes(zone as Zone)) return reply.code(400).send({ error: 'vue-invalide' });
      return queries.list(account.id, {
        ...view,
        filters: parseFilters(request.body.filters),
        zone: zone as Zone,
        sort: typeof sort === 'string' ? sort : 'size',
        descending: descending !== false,
        offset: typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0,
        limit: 200,
      });
    },
  );

  app.post<{ Body: { axis?: unknown; filters?: unknown; search?: unknown } }>('/api/gmail/facet', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const { axis, filters, search } = request.body ?? {};
    if (!isAxis(axis)) return reply.code(400).send({ error: 'vue-invalide' });
    return { values: queries.facet(account.id, axis, parseFilters(filters), typeof search === 'string' ? search.slice(0, 100) : '') };
  });

  app.get<{ Params: { id: string }; Querystring: { zone?: string } }>('/api/gmail/conversations/:id', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const zone = (request.query.zone ?? 'inbox') as Zone;
    const conversation = ZONES.includes(zone) ? queries.conversation(account.id, request.params.id, zone) : null;
    return conversation ?? reply.code(404).send({ error: 'introuvable' });
  });

  app.post<{ Body: { filters?: unknown } }>('/api/gmail/attachments', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return { attachments: queries.topAttachments(account.id, parseFilters(request.body?.filters), 200) };
  });

  // --- Nettoyage ---

  app.post<{ Body: ViewBody & { zone?: unknown } }>('/api/gmail/select', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const view = parseView(request.body);
    const zone = (request.body?.zone ?? 'inbox') as Zone;
    if (!view || !ZONES.includes(zone)) return reply.code(400).send({ error: 'vue-invalide' });
    return { items: queries.select(account.id, { ...view, filters: parseFilters(request.body?.filters) }, zone, MAX_TARGETS) };
  });

  registerCleanupRoutes(app, {
    prefix: '/api/gmail',
    engine: cleaner,
    zones: ZONES,
    // La restauration ne se demande pas ici : elle part toujours d'une mise à la corbeille du journal.
    actions: ACTIONS.filter((action) => action !== 'untrash'),
    deleteAction: 'delete',
    requireAccount,
    canWrite: (account) => canWriteGmail(store.getTokens(account.id)),
    busy: (account) => (isActive(gmail.latestScan(account.id)) ? 'scan-en-cours' : null),
  });

  /** Efface de ce serveur tout ce qui a été lu de Gmail ; le compte Google n'est pas touché. */
  app.post('/api/gmail/erase', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    await scanner.cancel(account.id);
    await cleaner.cancel(account.id);
    gmail.eraseAll(account.id);
    return { ok: true };
  });
}

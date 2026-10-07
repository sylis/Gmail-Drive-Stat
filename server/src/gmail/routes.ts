import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { canReadGmail, canWriteGmail, MissingScopeError, ReauthRequiredError, type GoogleGateway } from '../google.js';
import type { Account, Store } from '../store.js';
import { ACTIONS, type CleanupAction, type GmailCleaner, type ItemState, type Target } from './cleaner.js';
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
/** Taille maximale d'une sélection, et du corps de requête qui la transporte. */
const MAX_TARGETS = 200_000;
const SELECTION_BODY = { bodyLimit: 24 * 1024 * 1024 };
const STATES: ItemState[] = ['pending', 'done', 'failed', 'skipped'];

/** Briques visées par un nettoyage ; null si la liste est mal formée. */
function parseTargets(input: unknown): Target[] | null {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TARGETS) return null;
  const targets: Target[] = [];
  for (const entry of input as { id?: unknown; zone?: unknown }[]) {
    if (typeof entry?.id !== 'string' || entry.id.length > 64 || !ZONES.includes(entry.zone as Zone)) return null;
    targets.push({ id: entry.id, zone: entry.zone as Zone });
  }
  return targets;
}

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

  app.post<{ Body: { items?: unknown } }>('/api/gmail/cleanup/preview', SELECTION_BODY, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const targets = parseTargets(request.body?.items);
    if (!targets) return reply.code(400).send({ error: 'selection-invalide' });
    return cleaner.preview(account.id, targets);
  });

  app.post<{ Body: { action?: unknown; items?: unknown; simulate?: unknown; confirm?: unknown } }>(
    '/api/gmail/cleanup',
    SELECTION_BODY,
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const { action, simulate, confirm } = request.body ?? {};
      const targets = parseTargets(request.body?.items);
      // La restauration ne se demande pas ici : elle part toujours d'une mise à la corbeille du journal.
      if (!targets || !ACTIONS.includes(action as CleanupAction) || action === 'untrash') {
        return reply.code(400).send({ error: 'selection-invalide' });
      }
      const preview = cleaner.preview(account.id, targets);
      if (preview.conversations === 0) return reply.code(400).send({ error: 'selection-vide' });
      // Confirmation renforcée, vérifiée aussi par le serveur : le nombre de conversations saisi doit être le bon.
      if (action === 'delete' && confirm !== preview.conversations) return reply.code(400).send({ error: 'confirmation-requise' });
      if (simulate !== true && !canWriteGmail(store.getTokens(account.id))) return reply.code(403).send({ error: 'autorisation-incomplete' });
      if (isActive(gmail.latestScan(account.id))) return reply.code(409).send({ error: 'scan-en-cours' });
      const cleanup = cleaner.start(account.id, action as CleanupAction, targets, simulate === true);
      if (!cleanup) return reply.code(409).send({ error: 'nettoyage-en-cours' });
      return { cleanup: cleaner.progress(account.id) };
    },
  );

  app.post('/api/gmail/cleanup/cancel', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    await cleaner.cancel(account.id);
    return { cleanup: cleaner.progress(account.id) };
  });

  app.get('/api/gmail/cleanups', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    reply.header('Cache-Control', 'no-store');
    return { cleanups: cleaner.journal(account.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { state?: string; offset?: string } }>(
    '/api/gmail/cleanups/:id/items',
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const state = STATES.includes(request.query.state as ItemState) ? (request.query.state as ItemState) : null;
      const items = cleaner.items(account.id, Number(request.params.id), state, Math.max(0, Number(request.query.offset) || 0), 200);
      return items ? { items } : reply.code(404).send({ error: 'introuvable' });
    },
  );

  app.post<{ Params: { id: string }; Body: { item?: { id?: unknown; zone?: unknown } } }>(
    '/api/gmail/cleanups/:id/retry',
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      if (isActive(gmail.latestScan(account.id))) return reply.code(409).send({ error: 'scan-en-cours' });
      const only = request.body?.item ? parseTargets([request.body.item]) : undefined;
      if (only === null) return reply.code(400).send({ error: 'selection-invalide' });
      if (!cleaner.retry(account.id, Number(request.params.id), only?.[0])) return reply.code(409).send({ error: 'nettoyage-en-cours' });
      return { cleanup: cleaner.progress(account.id) };
    },
  );

  app.post<{ Params: { id: string } }>('/api/gmail/cleanups/:id/restore', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    if (isActive(gmail.latestScan(account.id))) return reply.code(409).send({ error: 'scan-en-cours' });
    if (!cleaner.restore(account.id, Number(request.params.id))) return reply.code(409).send({ error: 'restauration-impossible' });
    return { cleanup: cleaner.progress(account.id) };
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

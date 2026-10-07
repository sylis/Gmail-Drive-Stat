import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { MAX_TARGETS, registerCleanupRoutes } from '../cleanup-routes.js';
import { canReadDrive, canWriteDrive } from '../google.js';
import type { Account, Store } from '../store.js';
import { DRIVE_ACTIONS, type DriveCleaner } from './cleaner.js';
import { DRIVE_ZONES, DriveQueries, parseDriveFilters, type DriveView, type DriveZone } from './queries.js';
import type { DriveScanner } from './scanner.js';
import { isScanning, type DriveStore } from './store.js';

export interface DriveDeps {
  store: Store;
  drive: DriveStore;
  scanner: DriveScanner;
  cleaner: DriveCleaner;
  /** Renvoie le compte de la session, ou répond 401 et renvoie null. */
  requireAccount: (request: FastifyRequest, reply: FastifyReply) => Account | null;
}

interface ViewBody {
  folder?: unknown;
  filters?: unknown;
}

function parseView(body: ViewBody | undefined): DriveView {
  const folder = typeof body?.folder === 'string' && body.folder.length > 0 && body.folder.length <= 128 ? body.folder : null;
  return { folder, filters: parseDriveFilters(body?.filters) };
}

const parseZone = (value: unknown): DriveZone | null => (DRIVE_ZONES.includes(value as DriveZone) ? (value as DriveZone) : null);

export function registerDriveRoutes(app: FastifyInstance, { store, drive, scanner, cleaner, requireAccount }: DriveDeps): void {
  const queries = new DriveQueries(drive);

  app.get('/api/drive/state', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const tokens = store.getTokens(account.id);
    reply.header('Cache-Control', 'no-store');
    return {
      authorized: canReadDrive(tokens),
      canClean: canWriteDrive(tokens),
      scan: scanner.progress(account.id),
      cleanup: cleaner.progress(account.id),
      summary: queries.summary(account.id),
    };
  });

  app.post('/api/drive/scan', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    // Un scan et un nettoyage ne tournent pas en même temps : le scan remplacerait ce que le nettoyage vient d'écrire.
    if (cleaner.active(account.id)) return reply.code(409).send({ error: 'nettoyage-en-cours' });
    if (!scanner.start(account.id)) return reply.code(409).send({ error: 'scan-deja-en-cours' });
    return { scan: scanner.progress(account.id) };
  });

  app.post('/api/drive/scan/cancel', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    await scanner.cancel(account.id);
    return { scan: scanner.progress(account.id) };
  });

  app.post<{ Body: ViewBody & { group?: unknown } }>('/api/drive/treemap', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const view = parseView(request.body);
    return {
      tree: queries.treemap(account.id, view, request.body?.group === 'type' ? 'type' : 'folder'),
      trash: queries.trash(account.id, view.filters),
      crumbs: queries.crumbs(account.id, view.folder),
    };
  });

  app.post<{ Body: ViewBody & { zone?: unknown; sort?: unknown; descending?: unknown; offset?: unknown } }>(
    '/api/drive/list',
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const { zone = 'files', sort, descending, offset } = request.body ?? {};
      const parsed = parseZone(zone);
      if (!parsed) return reply.code(400).send({ error: 'vue-invalide' });
      return queries.list(account.id, parseView(request.body), {
        zone: parsed,
        sort: typeof sort === 'string' ? sort : 'size',
        descending: descending !== false,
        offset: typeof offset === 'number' && offset > 0 ? Math.floor(offset) : 0,
        limit: 200,
      });
    },
  );

  app.post<{ Body: ViewBody & { zone?: unknown } }>('/api/drive/select', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const zone = parseZone(request.body?.zone ?? 'files');
    if (!zone) return reply.code(400).send({ error: 'vue-invalide' });
    return { items: queries.select(account.id, parseView(request.body), zone, MAX_TARGETS) };
  });

  app.get<{ Params: { id: string } }>('/api/drive/files/:id', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    return queries.file(account.id, request.params.id) ?? reply.code(404).send({ error: 'introuvable' });
  });

  registerCleanupRoutes(app, {
    prefix: '/api/drive',
    engine: cleaner,
    zones: DRIVE_ZONES,
    // La restauration ne se demande pas ici : elle part toujours d'une mise à la corbeille du journal.
    actions: DRIVE_ACTIONS.filter((action) => action !== 'untrash'),
    deleteAction: 'delete',
    requireAccount,
    canWrite: (account) => canWriteDrive(store.getTokens(account.id)),
    busy: (account) => (isScanning(drive.latestScan(account.id)) ? 'scan-en-cours' : null),
  });

  /** Efface de ce serveur tout ce qui a été lu de Drive ; le compte Google n'est pas touché. */
  app.post('/api/drive/erase', async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    await scanner.cancel(account.id);
    await cleaner.cancel(account.id);
    drive.eraseAll(account.id);
    return { ok: true };
  });
}

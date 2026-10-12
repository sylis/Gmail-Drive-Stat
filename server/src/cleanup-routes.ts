import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CleanupEngine, ItemState, Target } from './cleanup.js';
import type { Account } from './store.js';

/** Taille maximale d'une sélection, et du corps de requête qui la transporte. */
export const MAX_TARGETS = 200_000;
const SELECTION_BODY = { bodyLimit: 24 * 1024 * 1024 };
const STATES: ItemState[] = ['pending', 'done', 'failed', 'skipped'];

export interface CleanupRouteOptions {
  /** Préfixe des routes du service, ex. /api/gmail. */
  prefix: string;
  engine: CleanupEngine;
  zones: readonly string[];
  /** Actions que l'interface peut demander ; la restauration part toujours du journal. */
  actions: readonly string[];
  /** Action irréversible, soumise à la confirmation renforcée. */
  deleteAction: string;
  requireAccount: (request: FastifyRequest, reply: FastifyReply) => Account | null;
  /** L'accès en écriture a été accordé pour ce compte. */
  canWrite: (account: Account) => boolean;
  /** Code d'erreur si une autre tâche empêche de nettoyer maintenant (un scan en cours) ; null sinon. */
  busy: (account: Account) => string | null;
}

/** Routes de nettoyage communes à Gmail et à Drive : récapitulatif, lancement, suivi, journal, reprise, restauration. */
export function registerCleanupRoutes(app: FastifyInstance, options: CleanupRouteOptions): void {
  const { prefix, engine, zones, actions, deleteAction, requireAccount, canWrite, busy } = options;

  /** Éléments visés par un nettoyage ; null si la liste est mal formée. */
  const parseTargets = (input: unknown): Target[] | null => {
    if (!Array.isArray(input) || input.length === 0 || input.length > MAX_TARGETS) return null;
    const targets: Target[] = [];
    for (const entry of input as { id?: unknown; zone?: unknown }[]) {
      if (typeof entry?.id !== 'string' || entry.id.length > 128 || !zones.includes(entry.zone as string)) return null;
      targets.push({ id: entry.id, zone: entry.zone as string });
    }
    return targets;
  };

  app.post<{ Body: { items?: unknown } }>(`${prefix}/cleanup/preview`, SELECTION_BODY, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const targets = parseTargets(request.body?.items);
    if (!targets) return reply.code(400).send({ error: 'selection-invalide' });
    return engine.preview(account.id, targets);
  });

  app.post<{ Body: { action?: unknown; items?: unknown; simulate?: unknown; confirm?: unknown } }>(
    `${prefix}/cleanup`,
    SELECTION_BODY,
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const { action, simulate, confirm } = request.body ?? {};
      const targets = parseTargets(request.body?.items);
      if (!targets || typeof action !== 'string' || !actions.includes(action)) return reply.code(400).send({ error: 'selection-invalide' });
      const preview = engine.preview(account.id, targets);
      if (preview.conversations === 0) return reply.code(400).send({ error: 'selection-vide' });
      // Confirmation renforcée, vérifiée aussi par le serveur : le nombre d'éléments saisi doit être le bon.
      if (action === deleteAction && confirm !== preview.conversations) return reply.code(400).send({ error: 'confirmation-requise' });
      if (simulate !== true && !canWrite(account)) return reply.code(403).send({ error: 'autorisation-incomplete' });
      const blocked = busy(account);
      if (blocked) return reply.code(409).send({ error: blocked });
      if (!engine.start(account.id, action, targets, simulate === true)) return reply.code(409).send({ error: 'nettoyage-en-cours' });
      return { cleanup: engine.progress(account.id) };
    },
  );

  app.post(`${prefix}/cleanup/cancel`, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    await engine.cancel(account.id);
    return { cleanup: engine.progress(account.id) };
  });

  app.get(`${prefix}/cleanups`, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    reply.header('Cache-Control', 'no-store');
    return { cleanups: engine.journal(account.id) };
  });

  app.get<{ Params: { id: string }; Querystring: { state?: string; offset?: string } }>(
    `${prefix}/cleanups/:id/items`,
    async (request, reply) => {
      const account = requireAccount(request, reply);
      if (!account) return;
      const state = STATES.includes(request.query.state as ItemState) ? (request.query.state as ItemState) : null;
      const items = engine.items(account.id, Number(request.params.id), state, Math.max(0, Number(request.query.offset) || 0), 200);
      return items ? { items } : reply.code(404).send({ error: 'introuvable' });
    },
  );

  app.post<{ Params: { id: string }; Body: { item?: unknown } }>(`${prefix}/cleanups/:id/retry`, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const blocked = busy(account);
    if (blocked) return reply.code(409).send({ error: blocked });
    const only = request.body?.item ? parseTargets([request.body.item]) : undefined;
    if (only === null) return reply.code(400).send({ error: 'selection-invalide' });
    if (!engine.retry(account.id, Number(request.params.id), only?.[0])) return reply.code(409).send({ error: 'nettoyage-en-cours' });
    return { cleanup: engine.progress(account.id) };
  });

  app.post<{ Params: { id: string } }>(`${prefix}/cleanups/:id/restore`, async (request, reply) => {
    const account = requireAccount(request, reply);
    if (!account) return;
    const blocked = busy(account);
    if (blocked) return reply.code(409).send({ error: blocked });
    if (!engine.restore(account.id, Number(request.params.id))) return reply.code(409).send({ error: 'restauration-impossible' });
    return { cleanup: engine.progress(account.id) };
  });
}

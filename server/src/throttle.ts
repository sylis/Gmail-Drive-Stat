import { RetryLaterError } from './google.js';

/** Levée quand la tâche de fond est mise en pause, annulée ou arrêtée avec le serveur. */
export class Stopped extends Error {}

/** État d'une tâche de fond que le régulateur consulte et renseigne. */
export interface Pacer {
  stop: boolean;
  /** Google a demandé de ralentir : reprise automatique à cette date (ms). */
  retryAt: number | null;
}

export interface ThrottleOptions {
  /** Débit visé, en unités de quota Google par seconde (plafond Gmail : 250 par utilisateur). */
  unitsPerSecond?: number;
  /** Attente après un « ralentissez » de Google, en millisecondes, selon le nombre d'essais consécutifs. */
  backoff?: (attempt: number) => number;
}

const MAX_ATTEMPTS = 8;

/** Appelle Google au rythme autorisé ; patiente et retente quand il demande de ralentir. */
export class Throttle {
  readonly #unitsPerSecond: number;
  readonly #backoff: (attempt: number) => number;
  #nextSlot = 0;

  constructor(options: ThrottleOptions = {}) {
    this.#unitsPerSecond = options.unitsPerSecond ?? 200;
    this.#backoff = options.backoff ?? ((attempt) => Math.min(60_000, 2000 * 2 ** (attempt - 1)));
  }

  async call<T>(pacer: Pacer, cost: number, request: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const now = Date.now();
      const slot = Math.max(now, this.#nextSlot);
      this.#nextSlot = slot + (cost / this.#unitsPerSecond) * 1000;
      await pause(pacer, slot - now);
      try {
        const result = await request();
        pacer.retryAt = null;
        return result;
      } catch (error) {
        if (!(error instanceof RetryLaterError) || attempt >= MAX_ATTEMPTS) throw error;
        const wait = this.#backoff(attempt);
        pacer.retryAt = Math.max(pacer.retryAt ?? 0, Date.now() + wait);
        // Tous les appels en attente patientent, pas seulement celui-ci.
        this.#nextSlot = Math.max(this.#nextSlot, Date.now() + wait);
        await pause(pacer, wait);
      }
    }
  }
}

/** Attend `ms` millisecondes, en s'interrompant vite si la tâche est arrêtée. */
async function pause(pacer: Pacer, ms: number): Promise<void> {
  for (const until = Date.now() + ms; ; ) {
    if (pacer.stop) throw new Stopped();
    const left = until - Date.now();
    if (left <= 0) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(left, 200)));
  }
}

/** Traite une file par lots, avec plusieurs appels à Google en parallèle. */
export async function drain<T>(concurrency: number, nextBatch: () => T[], handle: (item: T) => Promise<void>): Promise<void> {
  for (let batch = nextBatch(); batch.length > 0; batch = nextBatch()) {
    const queue = [...batch];
    const worker = async () => {
      try {
        for (let item = queue.shift(); item !== undefined; item = queue.shift()) await handle(item);
      } catch (error) {
        // Une erreur arrête le lot entier : les autres appels en cours se terminent, sans en lancer de nouveaux.
        queue.length = 0;
        throw error;
      }
    };
    const results = await Promise.allSettled(Array.from({ length: concurrency }, worker));
    const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
    if (failures.length > 0) throw failures.find((reason) => !(reason instanceof Stopped)) ?? failures[0];
  }
}

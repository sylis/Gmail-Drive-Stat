/** Ce que l'utilisateur choisit d'analyser avant un scan. */
export interface ScanScope {
  period: { kind: 'all' } | { kind: 'days'; days: number } | { kind: 'range'; from: string; to: string | null };
  /** Identifiants de libellés Gmail ; vide pour toute la boîte. */
  labelIds: string[];
  /** Taille minimale d'un message en Mo ; 0 pour ne pas filtrer. */
  minSizeMb: number;
  /** Lire la structure des pièces jointes des gros messages seulement, ou de tous. */
  attachmentDetail: 'large' | 'all';
}

/** Seuil des « gros messages » dont les pièces jointes sont toujours détaillées. */
export const LARGE_MESSAGE_BYTES = 1024 * 1024;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isDay = (value: unknown): value is string => typeof value === 'string' && DAY.test(value) && !Number.isNaN(Date.parse(value));

/** Valide un périmètre reçu du navigateur ; null s'il est mal formé. */
export function parseScope(input: unknown): ScanScope | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as Record<string, unknown>;
  const rawPeriod = (raw.period ?? {}) as Record<string, unknown>;

  let period: ScanScope['period'];
  if (rawPeriod.kind === 'all') period = { kind: 'all' };
  else if (rawPeriod.kind === 'days' && Number.isInteger(rawPeriod.days) && (rawPeriod.days as number) > 0) {
    period = { kind: 'days', days: Math.min(rawPeriod.days as number, 36500) };
  } else if (rawPeriod.kind === 'range' && isDay(rawPeriod.from) && (rawPeriod.to == null || isDay(rawPeriod.to))) {
    period = { kind: 'range', from: rawPeriod.from, to: (rawPeriod.to as string | null) ?? null };
  } else return null;

  const labelIds = raw.labelIds ?? [];
  if (!Array.isArray(labelIds) || !labelIds.every((id) => typeof id === 'string' && id.length > 0 && id.length < 200)) return null;
  const minSizeMb = raw.minSizeMb ?? 0;
  if (typeof minSizeMb !== 'number' || !Number.isInteger(minSizeMb) || minSizeMb < 0 || minSizeMb > 1000) return null;
  if (raw.attachmentDetail !== 'large' && raw.attachmentDetail !== 'all') return null;

  return { period, labelIds: [...new Set(labelIds as string[])], minSizeMb, attachmentDetail: raw.attachmentDetail };
}

/** Requête de recherche Gmail correspondant au périmètre (hors libellés, passés à part). */
export function scopeQuery(scope: ScanScope): string {
  const terms: string[] = [];
  const day = (value: string) => value.replaceAll('-', '/');
  if (scope.period.kind === 'days') terms.push(`newer_than:${scope.period.days}d`);
  if (scope.period.kind === 'range') {
    terms.push(`after:${day(scope.period.from)}`);
    if (scope.period.to) {
      // « before: » exclut le jour indiqué : on vise le lendemain pour inclure la date de fin.
      const next = new Date(Date.parse(scope.period.to) + 24 * 3600 * 1000).toISOString().slice(0, 10);
      terms.push(`before:${day(next)}`);
    }
  }
  if (scope.minSizeMb > 0) terms.push(`larger:${scope.minSizeMb}M`);
  return terms.join(' ');
}

/** Un scan de toute la boîte voit tout : ce qu'il ne liste plus a disparu du compte. */
export const isWholeMailbox = (scope: ScanScope) =>
  scope.period.kind === 'all' && scope.labelIds.length === 0 && scope.minSizeMb === 0;

/** Taille à partir de laquelle la structure des pièces jointes est lue. */
export const detailThreshold = (scope: ScanScope) => (scope.attachmentDetail === 'all' ? 0 : LARGE_MESSAGE_BYTES);

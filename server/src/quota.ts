import type { RawStorageQuota } from './google.js';

export type QuotaPartKey = 'drive' | 'driveTrash' | 'gmailPhotos' | 'free';

export interface QuotaBreakdown {
  /** Quota total en octets ; null pour un compte sans limite. */
  limit: number | null;
  usage: number;
  parts: { key: QuotaPartKey; bytes: number }[];
  fetchedAt: string;
}

const bytes = (value: string | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/**
 * Google ne publie que trois chiffres : l'usage total, la part de Drive et sa corbeille.
 * Gmail et Photos ne sont pas distingués : leur somme est ce qui reste de l'usage total
 * (Gmail sera mesuré par le scan du lot 2).
 * La corbeille Drive est comptée dans la part de Drive, on l'en retire pour l'afficher à part.
 */
export function breakdownQuota(raw: RawStorageQuota, now = new Date()): QuotaBreakdown {
  const usage = bytes(raw.usage);
  const inDrive = Math.min(bytes(raw.usageInDrive), usage);
  const driveTrash = Math.min(bytes(raw.usageInDriveTrash), inDrive);
  const limit = raw.limit === undefined ? null : bytes(raw.limit);

  const parts: QuotaBreakdown['parts'] = [
    { key: 'gmailPhotos', bytes: usage - inDrive },
    { key: 'drive', bytes: inDrive - driveTrash },
    { key: 'driveTrash', bytes: driveTrash },
  ];
  if (limit !== null) parts.push({ key: 'free', bytes: Math.max(limit - usage, 0) });

  return { limit, usage, parts, fetchedAt: now.toISOString() };
}

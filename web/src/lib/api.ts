export type Flash = { kind: 'refuse'; email: string } | { kind: 'annule' } | { kind: 'echec' };

export interface Status {
  configured: boolean;
  redirectUri: string;
  user: { email: string; name: string | null; picture: string | null } | null;
  needsReauth: boolean;
  flash: Flash | null;
}

export type QuotaPartKey = 'drive' | 'driveTrash' | 'gmailPhotos' | 'free';

export interface Quota {
  limit: number | null;
  usage: number;
  parts: { key: QuotaPartKey; bytes: number }[];
  fetchedAt: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export async function call<T>(path: string, method: 'GET' | 'POST' = 'GET', body?: object): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, data.error ?? 'erreur');
  return data as T;
}

export const getStatus = () => call<Status>('/api/status');
export const getQuota = () => call<Quota>('/api/quota');
export const logout = () => call<{ ok: true }>('/auth/logout', 'POST');
export const revokeAccount = () => call<{ ok: true; revokedAtGoogle: boolean }>('/api/account/revoke', 'POST');

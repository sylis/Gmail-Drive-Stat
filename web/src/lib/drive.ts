import { call } from './api';
import type { Cleanup, CleanupService } from './cleanup';
import type { TreeBrick, TreeNode } from './gmail';

export type DriveZone = 'files' | 'trash';

export interface DriveScan {
  id: number;
  status: 'running' | 'auth' | 'done' | 'cancelled' | 'failed';
  seen: number;
  error: string | null;
  createdAt: number;
  finishedAt: number | null;
  retryAt: number | null;
}

export interface DriveState {
  authorized: boolean;
  /** L'accès complet à Drive a été accordé : le nettoyage peut agir sur les fichiers. */
  canClean: boolean;
  scan: DriveScan | null;
  cleanup: Cleanup | null;
  summary: {
    files: { count: number; size: number };
    trash: { count: number; size: number };
    folders: number;
    lastScannedAt: number | null;
  };
}

export interface DriveFilters {
  types?: string[];
  minSize?: number;
  modifiedFrom?: string;
  modifiedTo?: string;
  name?: string;
}

export interface DriveView {
  folder: string | null;
  filters: DriveFilters;
}

export interface DriveTreemap {
  tree: TreeNode;
  trash: { v: number; c: number; bricks: TreeBrick[] };
  crumbs: { id: string; name: string }[];
}

export interface DriveListRow {
  id: string;
  zone: DriveZone;
  name: string;
  path: string;
  type: string;
  modified: number;
  size: number;
  shared: boolean;
}

export interface DriveFile {
  id: string;
  zone: DriveZone;
  name: string;
  path: string;
  mime: string;
  type: string;
  size: number;
  modified: number;
  shared: boolean;
  starred: boolean;
  link: string | null;
  folder: { id: string; name: string; files: number; size: number } | null;
}

export const getDriveState = () => call<DriveState>('/api/drive/state');
export const startDriveScan = () => call<{ scan: DriveScan }>('/api/drive/scan', 'POST');
export const cancelDriveScan = () => call<{ scan: DriveScan }>('/api/drive/scan/cancel', 'POST');
export const getDriveTreemap = (view: DriveView, group: 'folder' | 'type') => call<DriveTreemap>('/api/drive/treemap', 'POST', { ...view, group });
export const getDriveList = (view: DriveView & { zone: DriveZone; sort: string; descending: boolean; offset: number }) =>
  call<{ total: number; rows: DriveListRow[] }>('/api/drive/list', 'POST', view);
export const selectDriveFiles = (view: DriveView, zone: DriveZone) =>
  call<{ items: [string, number][] }>('/api/drive/select', 'POST', { ...view, zone });
export const getDriveFile = (id: string) => call<DriveFile>(`/api/drive/files/${encodeURIComponent(id)}`);

const plural = (n: number, word: string) => `${n.toLocaleString('fr-FR')} ${word}${n > 1 ? 's' : ''}`;

/** Nettoyage de Drive : mêmes écrans que pour Gmail, avec le vocabulaire des fichiers. */
export const driveCleanup: CleanupService = {
  preview: (items) => call('/api/drive/cleanup/preview', 'POST', { items }),
  start: (body) => call('/api/drive/cleanup', 'POST', body),
  cancel: () => call('/api/drive/cleanup/cancel', 'POST'),
  journal: () => call('/api/drive/cleanups'),
  items: (id, state, offset = 0) => call(`/api/drive/cleanups/${id}/items?offset=${offset}${state ? `&state=${state}` : ''}`),
  retry: (id, item) => call(`/api/drive/cleanups/${id}/retry`, 'POST', item ? { item } : {}),
  restore: (id) => call(`/api/drive/cleanups/${id}/restore`, 'POST'),
  count: (n) => plural(n, 'fichier'),
  actions: {
    trash: { name: 'Mise à la corbeille', done: 'mis à la corbeille' },
    delete: { name: 'Suppression définitive', done: 'supprimés définitivement' },
    untrash: { name: 'Restauration', done: 'restaurés' },
  },
  flaggedWarning: (n) =>
    n === 0
      ? ''
      : `${plural(n, 'fichier')} de la sélection ${n > 1 ? 'sont partagés' : 'est partagé'} avec d'autres personnes ou ${n > 1 ? 'suivis' : 'suivi'} : ${n > 1 ? 'ils disparaîtront' : 'il disparaîtra'} aussi pour elles.`,
  trashNote: "L'espace n'est libéré qu'au vidage de la corbeille Drive, sous 30 jours. Vous pourrez restaurer d'ici là.",
  name: 'Drive',
  itemLabel: 'Fichier',
};

/** Familles de fichiers : libellé et variable CSS de couleur, dans l'ordre de la légende. */
export const FILE_TYPES: Record<string, { label: string; color: string }> = {
  img: { label: 'Image', color: '--t-img' },
  vid: { label: 'Vidéo', color: '--t-vid' },
  pdf: { label: 'PDF', color: '--t-pdf' },
  doc: { label: 'Bureautique', color: '--t-doc' },
  zip: { label: 'Archive', color: '--t-zip' },
  aud: { label: 'Audio', color: '--t-aud' },
  oth: { label: 'Autre', color: '--t-oth' },
};

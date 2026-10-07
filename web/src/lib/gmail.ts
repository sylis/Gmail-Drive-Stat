import { call } from './api';
import type { Cleanup, CleanupService } from './cleanup';

export type Zone = 'inbox' | 'sent' | 'trash';
export type Axis = 'year' | 'quarter' | 'month' | 'label' | 'sender' | 'domain' | 'list' | 'group' | 'category' | 'attBucket' | 'attType';

export interface ScanScope {
  period: { kind: 'all' } | { kind: 'days'; days: number } | { kind: 'range'; from: string; to: string | null };
  labelIds: string[];
  minSizeMb: number;
  attachmentDetail: 'large' | 'all';
}

export interface ScanProgress {
  id: number;
  scope: ScanScope;
  status: 'running' | 'paused' | 'auth' | 'done' | 'cancelled' | 'failed';
  step: 'list' | 'read' | 'attachments';
  stats: {
    messagesRead: number;
    bytesRead: number;
    attachmentsFound: number;
    labelsDone: number;
    labelsTotal: number;
    detailTotal: number;
    detailDone: number;
  };
  threadsTotal: number;
  threadsDone: number;
  retryAt: number | null;
  etaSeconds: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

interface ZoneSummary {
  conversations: number;
  messages: number;
  size: number;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: string;
}

export interface GmailState {
  authorized: boolean;
  /** L'accès complet à Gmail a été accordé : le nettoyage peut agir sur la boîte. */
  canClean: boolean;
  scan: ScanProgress | null;
  cleanup: Cleanup | null;
  summary: {
    conversations: number;
    lastScannedAt: number | null;
    inbox: ZoneSummary;
    sent: ZoneSummary;
    trash: ZoneSummary;
    addresses: number;
    domains: number;
    oldest: number | null;
    newest: number | null;
  };
  scopes: { scope: ScanScope; finishedAt: number }[];
  labels: GmailLabel[];
}

export interface Filters {
  dateFrom?: string;
  dateTo?: string;
  minSize?: number;
  axes?: Partial<Record<Axis, { values: string[]; exclude?: boolean }>>;
}

export interface TreeBrick {
  id: string;
  v: number;
  t: string;
}

export interface TreeNode {
  k: string | null;
  v: number;
  c: number;
  children?: TreeNode[];
  bricks?: TreeBrick[];
  rest?: { c: number; v: number };
}

export interface ZoneData {
  v: number;
  c: number;
  bricks: TreeBrick[];
}

export interface TreemapData {
  tree: TreeNode;
  sent: ZoneData;
  trash: ZoneData;
}

export interface View {
  levels: Axis[];
  path: string[];
  filters: Filters;
}

export interface ListRow {
  id: string;
  zone: Zone;
  subject: string;
  domain: string;
  date: number;
  msgs: number;
  size: number;
  attType: string;
  attCount: number | null;
}

export interface Conversation {
  id: string;
  zone: Zone;
  subject: string;
  domain: string;
  sender: string;
  date: number;
  msgs: number;
  size: number;
  label: string;
  category: string;
  list: string;
  flagged: boolean;
  messages: { id: string; from: string; fromName: string; to: string; subject: string; date: number; size: number; attCount: number | null }[];
  attachments: { name: string; type: string; size: number }[];
  otherZones: { zone: Zone; msgs: number; size: number }[];
}

export interface TopAttachment {
  name: string;
  type: string;
  size: number;
  threadId: string;
  zone: Zone;
  subject: string;
  from: string;
  date: number;
  brickSize: number;
}

export interface FacetValue {
  value: string;
  size: number;
  count: number;
}

export const getGmailState = () => call<GmailState>('/api/gmail/state');
export const getMailbox = () => call<{ messagesTotal: number; threadsTotal: number; labels: GmailLabel[] }>('/api/gmail/mailbox');
export const startScan = (scope: ScanScope) => call<{ scan: ScanProgress }>('/api/gmail/scan', 'POST', { scope });
export const scanAction = (action: 'pause' | 'resume' | 'cancel') => call<{ scan: ScanProgress }>(`/api/gmail/scan/${action}`, 'POST');
export const getTreemap = (view: View) => call<TreemapData>('/api/gmail/treemap', 'POST', view);
export const getList = (view: View & { zone: Zone; sort: string; descending: boolean; offset: number }) =>
  call<{ total: number; rows: ListRow[] }>('/api/gmail/list', 'POST', view);
export const getFacet = (axis: Axis, filters: Filters, search: string) =>
  call<{ values: FacetValue[] }>('/api/gmail/facet', 'POST', { axis, filters, search });
export const getConversation = (id: string, zone: Zone) =>
  call<Conversation>(`/api/gmail/conversations/${encodeURIComponent(id)}?zone=${zone}`);
export const getTopAttachments = (filters: Filters) => call<{ attachments: TopAttachment[] }>('/api/gmail/attachments', 'POST', { filters });
export const eraseGmail = () => call<{ ok: true }>('/api/gmail/erase', 'POST');

export const selectAll = (view: View, zone: Zone) => call<{ items: [string, number][] }>('/api/gmail/select', 'POST', { ...view, zone });

const plural = (n: number, word: string) => `${n.toLocaleString('fr-FR')} ${word}${n > 1 ? 's' : ''}`;

/** Nettoyage de Gmail : appels du serveur et vocabulaire des conversations. */
export const gmailCleanup: CleanupService = {
  preview: (items) => call('/api/gmail/cleanup/preview', 'POST', { items }),
  start: (body) => call('/api/gmail/cleanup', 'POST', body),
  cancel: () => call('/api/gmail/cleanup/cancel', 'POST'),
  journal: () => call('/api/gmail/cleanups'),
  items: (id, state, offset = 0) => call(`/api/gmail/cleanups/${id}/items?offset=${offset}${state ? `&state=${state}` : ''}`),
  retry: (id, item) => call(`/api/gmail/cleanups/${id}/retry`, 'POST', item ? { item } : {}),
  restore: (id) => call(`/api/gmail/cleanups/${id}/restore`, 'POST'),
  count: (n) => plural(n, 'conversation'),
  actions: {
    trash: { name: 'Mise à la corbeille', done: 'mises à la corbeille' },
    delete: { name: 'Suppression définitive', done: 'supprimées définitivement' },
    archive: { name: 'Archivage', done: 'archivées' },
    read: { name: 'Marquage comme lu', done: 'marquées comme lues' },
    unread: { name: 'Marquage comme non lu', done: 'marquées comme non lues' },
    untrash: { name: 'Restauration', done: 'restaurées' },
  },
  flaggedWarning: (n) =>
    n === 0 ? '' : `${plural(n, 'conversation')} de la sélection ${n > 1 ? 'contiennent' : 'contient'} un message marqué important ou suivi.`,
  trashNote: "L'espace n'est libéré qu'au vidage de la corbeille Gmail, sous 30 jours. Vous pourrez restaurer d'ici là.",
  name: 'Gmail',
  itemLabel: 'Conversation',
};

// --- Libellés d'affichage ---

export const AXIS_LABELS: Record<Axis, string> = {
  year: 'Année',
  quarter: 'Trimestre',
  month: 'Mois',
  label: 'Libellé',
  sender: 'Expéditeur',
  domain: 'Domaine',
  list: 'Liste de diffusion',
  group: 'Groupe À / Cc',
  category: 'Catégorie Gmail',
  attBucket: 'Nombre de PJ',
  attType: 'Type de PJ',
};

/** Types de pièce jointe : libellé et variable CSS de couleur, dans l'ordre de la légende. */
export const ATT_TYPES: Record<string, { label: string; color: string }> = {
  none: { label: 'Sans pièce jointe', color: '--t-none' },
  img: { label: 'Image', color: '--t-img' },
  pdf: { label: 'PDF', color: '--t-pdf' },
  doc: { label: 'Bureautique', color: '--t-doc' },
  vid: { label: 'Vidéo', color: '--t-vid' },
  zip: { label: 'Archive', color: '--t-zip' },
  aud: { label: 'Audio', color: '--t-aud' },
  oth: { label: 'Autre', color: '--t-oth' },
  unk: { label: 'Pièces jointes non lues', color: '--t-unk' },
};

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const BUCKETS: Record<string, string> = { '0': 'Sans PJ', '1': '1 PJ', '2-5': '2 à 5 PJ', '6+': '6 PJ et plus', unk: 'PJ non lues' };
const EMPTY: Partial<Record<Axis, string>> = {
  label: 'Sans libellé',
  sender: 'Expéditeur inconnu',
  domain: 'Domaine inconnu',
  list: 'Hors liste de diffusion',
  group: 'Sans destinataire',
  category: 'Sans catégorie',
};

/** Nom lisible d'une valeur d'axe (bloc du treemap, ligne de filtre). */
export function axisValueLabel(axis: Axis, value: string): string {
  if (axis === 'month') return MONTHS[Number(value) - 1] ?? value;
  if (axis === 'attBucket') return BUCKETS[value] ?? value;
  if (axis === 'attType') return ATT_TYPES[value]?.label ?? value;
  return value || EMPTY[axis] || '—';
}

export const ZONE_LABELS: Record<Zone, string> = { inbox: 'Reçus', sent: 'Envoyés', trash: 'Corbeille' };

export function describeScope(scope: ScanScope, labels: GmailLabel[]): string[] {
  const day = (value: string) => new Date(value).toLocaleDateString('fr-FR');
  const period =
    scope.period.kind === 'all'
      ? 'toute la boîte'
      : scope.period.kind === 'days'
        ? `${scope.period.days} derniers jours`
        : `${day(scope.period.from)} → ${scope.period.to ? day(scope.period.to) : "aujourd'hui"}`;
  const names = scope.labelIds.map((id) => labels.find((label) => label.id === id)?.name ?? id);
  return [
    period,
    names.length === 0 ? 'tous libellés' : names.length <= 2 ? names.join(', ') : `${names.length} libellés`,
    ...(scope.minSizeMb > 0 ? [`messages ≥ ${scope.minSizeMb} Mo`] : []),
  ];
}

/** Lien vers la conversation dans Gmail, sur le bon compte. */
export const gmailLink = (email: string, threadId: string) =>
  `https://mail.google.com/mail/?authuser=${encodeURIComponent(email)}#all/${threadId}`;

// Mécanisme de nettoyage commun à Gmail et à Drive : sélection, récapitulatif, exécution suivie, journal.

export type ItemState = 'pending' | 'done' | 'failed' | 'skipped';

/** Un élément visé : une brique du treemap, identifiée dans sa zone. */
export interface Target {
  id: string;
  zone: string;
}

export interface Cleanup {
  id: number;
  action: string;
  simulate: boolean;
  status: 'running' | 'auth' | 'done' | 'cancelled' | 'failed';
  error: string | null;
  sourceId: number | null;
  createdAt: number;
  finishedAt: number | null;
  counts: Record<ItemState, { conversations: number; messages: number; size: number }>;
  retryAt: number | null;
  restorable: boolean;
}

export interface CleanupItem extends Target {
  subject: string;
  domain: string;
  size: number;
  msgs: number;
  state: ItemState;
  error: string | null;
}

export interface CleanupPreview {
  conversations: number;
  messages: number;
  size: number;
  flagged: number;
  top: { subject: string; size: number; msgs: number }[];
}

/** Ce qu'un service (Gmail, Drive) fournit aux écrans de nettoyage : ses appels et son vocabulaire. */
export interface CleanupService {
  preview(items: Target[]): Promise<CleanupPreview>;
  start(body: { action: string; items: Target[]; simulate: boolean; confirm?: number }): Promise<{ cleanup: Cleanup }>;
  cancel(): Promise<unknown>;
  journal(): Promise<{ cleanups: Cleanup[] }>;
  items(id: number, state?: ItemState, offset?: number): Promise<{ items: CleanupItem[] }>;
  retry(id: number, item?: Target): Promise<unknown>;
  restore(id: number): Promise<unknown>;
  /** « 3 conversations », « 1 fichier ». */
  count(n: number): string;
  /** Nom de l'opération et participe accordé : « Mise à la corbeille », « mises à la corbeille ». */
  actions: Record<string, { name: string; done: string }>;
  /** Avertissement affiché quand la sélection contient des éléments à protéger ; vide si sans objet. */
  flaggedWarning(n: number): string;
  /** Rappel affiché avant une mise à la corbeille. */
  trashNote: string;
  /** Nom du service dans les phrases : « Gmail », « Drive ». */
  name: string;
  /** Intitulé de la colonne qui décrit un élément dans le journal. */
  itemLabel: string;
}

const FAILURES: Record<string, string> = {
  introuvable: 'Introuvable sur le compte : relancez un scan.',
  refus: 'Google a refusé l’opération.',
  'requete-refusee': 'Google a refusé l’opération.',
  'erreur-google': 'Erreur de Google.',
};
export const failureReason = (code: string | null) => FAILURES[code ?? ''] ?? 'Échec.';

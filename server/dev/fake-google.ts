import {
  canReadGmail,
  canWriteGmail,
  MissingScopeError,
  NotFoundError,
  SCOPES,
  type GmailApi,
  type GoogleGateway,
  type GoogleProfile,
  type GoogleTokens,
  type RawGmailMessage,
  type RawStorageQuota,
} from '../src/google.ts';

export interface FakeThread {
  id: string;
  historyId: string;
  messages: RawGmailMessage[];
}

/**
 * Faux compte Google en mémoire, pour les tests et le mode démonstration : aucune donnée réelle, aucun appel réseau.
 * Il renvoie les mêmes structures que les API Gmail et Drive.
 */
export class FakeGoogle implements GoogleGateway {
  profile: GoogleProfile = { sub: 'sub-1', email: 'moi@example.com', emailVerified: true, name: 'Moi' };
  tokens: GoogleTokens = { refresh_token: 'rt', access_token: 'at', scope: SCOPES.join(' ') };
  quota: RawStorageQuota = { limit: '100', usage: '40', usageInDrive: '10', usageInDriveTrash: '0' };
  labelList = [
    { id: 'INBOX', name: 'INBOX', type: 'system' },
    { id: 'SENT', name: 'SENT', type: 'system' },
    { id: 'TRASH', name: 'TRASH', type: 'system' },
    { id: 'Label_1', name: 'Achats', type: 'user' },
    { id: 'Label_2', name: 'Famille', type: 'user' },
    { id: 'Label_3', name: 'Administratif', type: 'user' },
    { id: 'Label_4', name: 'Voyages', type: 'user' },
  ];
  threads = new Map<string, FakeThread>();
  revoked = 0;
  calls = { listThreads: 0, getThread: 0, getMessage: 0, trash: 0, untrash: 0, delete: 0, batchDelete: 0, batchModify: 0 };
  /** Messages que « Gmail » refuse de modifier ou de supprimer (erreur définitive, sans nouvelle tentative). */
  refused = new Set<string>();
  /** Erreurs à lever lors des prochains appels à Gmail, dans l'ordre. */
  failures: Error[] = [];
  pageSize = 100;
  /** Délai simulé de chaque appel, en millisecondes. */
  latencyMs = 0;
  #history = 1000;

  authUrl({ state, forceConsent }: { state: string; forceConsent: boolean }): string {
    return `https://google.test/auth?state=${state}&consent=${forceConsent}`;
  }

  async exchangeCode(): Promise<{ tokens: GoogleTokens; profile: GoogleProfile }> {
    return { tokens: this.tokens, profile: this.profile };
  }

  async revoke(): Promise<void> {
    this.revoked++;
  }

  async storageQuota(): Promise<RawStorageQuota> {
    await this.#before();
    return this.quota;
  }

  async #before(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
    const failure = this.failures.shift();
    if (failure) throw failure;
  }

  /** Ajoute une conversation ; `messages` reçoit les valeurs par défaut manquantes. */
  addThread(id: string, messages: Partial<RawGmailMessage>[] & { length: number }): FakeThread {
    const thread: FakeThread = {
      id,
      historyId: String(this.#history++),
      messages: messages.map((message, index) => ({
        id: `${id}-m${index}`,
        threadId: id,
        labelIds: ['INBOX'],
        sizeEstimate: 1000,
        internalDate: String(Date.UTC(2024, 0, 1 + index)),
        ...message,
      })),
    };
    this.threads.set(id, thread);
    return thread;
  }

  /** Signale à Gmail qu'une conversation a changé : son repère d'historique avance. */
  touch(id: string): void {
    const thread = this.threads.get(id);
    if (thread) thread.historyId = String(this.#history++);
  }

  #find(id: string): { thread: FakeThread; message: RawGmailMessage } {
    for (const thread of this.threads.values()) {
      const message = thread.messages.find((candidate) => candidate.id === id);
      if (message) return { thread, message };
    }
    throw new NotFoundError('message supprimé');
  }

  #relabel(id: string, add: string[], remove: string[]): void {
    const { thread, message } = this.#find(id);
    message.labelIds = [...new Set([...(message.labelIds ?? []).filter((label) => !remove.includes(label)), ...add])];
    this.touch(thread.id);
  }

  #remove(id: string): void {
    const { thread } = this.#find(id);
    thread.messages = thread.messages.filter((message) => message.id !== id);
    if (thread.messages.length === 0) this.threads.delete(thread.id);
    else this.touch(thread.id);
  }

  gmail(tokens: GoogleTokens): GmailApi {
    if (!canReadGmail(tokens)) throw new MissingScopeError('Lecture de Gmail non autorisée');
    /** Préambule de toute écriture : autorisation, pannes simulées, refus par message. */
    const write = async (ids: string[]): Promise<void> => {
      if (!canWriteGmail(tokens)) throw new MissingScopeError('Modification de Gmail non autorisée');
      await this.#before();
      const refused = ids.find((id) => this.refused.has(id));
      if (refused) throw Object.assign(new Error('Gmail refuse cette opération'), { response: { status: 400 } });
    };
    const strip = (message: RawGmailMessage, detail: boolean): RawGmailMessage =>
      detail ? message : { ...message, payload: { headers: message.payload?.headers } };
    return {
      profile: async () => {
        await this.#before();
        const messagesTotal = [...this.threads.values()].reduce((sum, thread) => sum + thread.messages.length, 0);
        return { messagesTotal, threadsTotal: this.threads.size };
      },
      labels: async () => {
        await this.#before();
        return this.labelList;
      },
      listThreads: async ({ labelId, query, pageToken }) => {
        await this.#before();
        this.calls.listThreads++;
        const matches = [...this.threads.values()].filter((thread) =>
          thread.messages.some((message) => (!labelId || message.labelIds?.includes(labelId)) && matchesQuery(message, query)),
        );
        const start = Number(pageToken ?? 0);
        const page = matches.slice(start, start + this.pageSize);
        return {
          threads: page.map(({ id, historyId }) => ({ id, historyId })),
          nextPageToken: start + this.pageSize < matches.length ? String(start + this.pageSize) : undefined,
        };
      },
      getThread: async (id, detail) => {
        await this.#before();
        this.calls.getThread++;
        const thread = this.threads.get(id);
        if (!thread) throw new NotFoundError('conversation supprimée');
        return thread.messages.map((message) => strip(message, detail));
      },
      getMessage: async (id) => {
        await this.#before();
        this.calls.getMessage++;
        return this.#find(id).message;
      },
      trashMessage: async (id) => {
        await write([id]);
        this.calls.trash++;
        this.#relabel(id, ['TRASH'], ['INBOX']);
      },
      untrashMessage: async (id) => {
        await write([id]);
        this.calls.untrash++;
        this.#relabel(id, [], ['TRASH']);
      },
      deleteMessage: async (id) => {
        await write([id]);
        this.calls.delete++;
        this.#remove(id);
      },
      batchDelete: async (ids) => {
        await write(ids);
        this.calls.batchDelete++;
        for (const id of ids) this.#remove(id);
      },
      batchModify: async (ids, { add = [], remove = [] }) => {
        await write(ids);
        this.calls.batchModify++;
        for (const id of ids) this.#relabel(id, add, remove);
      },
    };
  }
}

/** Sous-ensemble de la recherche Gmail utilisé par le scan : taille et dates. */
function matchesQuery(message: RawGmailMessage, query = ''): boolean {
  const date = Number(message.internalDate ?? 0);
  return query.split(/\s+/).filter(Boolean).every((term) => {
    const [key, value = ''] = term.split(':');
    if (key === 'larger') return (message.sizeEstimate ?? 0) >= parseInt(value, 10) * 1024 * 1024;
    if (key === 'newer_than') return date >= Date.now() - parseInt(value, 10) * 24 * 3600 * 1000;
    if (key === 'after') return date >= Date.parse(value.replaceAll('/', '-'));
    if (key === 'before') return date < Date.parse(value.replaceAll('/', '-'));
    return true;
  });
}

/** Fabrique un message Gmail fictif à partir de ses caractéristiques utiles. */
export function fakeMessage(options: {
  from?: string;
  to?: string;
  cc?: string;
  subject?: string;
  listId?: string;
  labels?: string[];
  size?: number;
  date?: number;
  attachments?: { name: string; mimeType: string; size: number }[];
}): Partial<RawGmailMessage> {
  const headers = [
    { name: 'From', value: options.from ?? 'Camille <camille@gmail.com>' },
    { name: 'To', value: options.to ?? 'moi@example.com' },
    { name: 'Subject', value: options.subject ?? 'Sans objet' },
  ];
  if (options.cc) headers.push({ name: 'Cc', value: options.cc });
  if (options.listId) headers.push({ name: 'List-Id', value: options.listId });
  return {
    labelIds: options.labels ?? ['INBOX'],
    sizeEstimate: options.size ?? 2000,
    ...(options.date === undefined ? {} : { internalDate: String(options.date) }),
    payload: {
      headers,
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: '', body: { size: 300 } },
        ...(options.attachments ?? []).map((attachment) => ({
          mimeType: attachment.mimeType,
          filename: attachment.name,
          body: { size: attachment.size, attachmentId: 'att' },
        })),
      ],
    },
  };
}

const SENDERS: [string, string, string[]][] = [
  ['gmail.com', 'Camille <camille@gmail.com>', ['Photos du week-end', 'Re: vacances en Crète', 'Les vidéos de la fête', 'Papiers maison']],
  ['amazon.fr', 'Amazon <confirmation@amazon.fr>', ['Votre commande de 3 articles', 'Facture et notice TV', 'Retour accepté']],
  ['sncf-connect.com', 'SNCF Connect <billets@info.sncf-connect.com>', ['Billet Lyon–Paris', 'Votre e-billet', 'Confirmation de voyage']],
  ['free.fr', 'Free <facture@free.fr>', ['Votre facture Freebox', 'Message vocal reçu']],
  ['impots.gouv.fr', 'Impôts <ne-pas-repondre@dgfip.impots.gouv.fr>', ["Avis d'imposition", 'Accusé de réception']],
  ['linkedin.com', 'LinkedIn <jobs@news.linkedin.com>', ['Nouvelles offres', 'Vous avez 4 invitations']],
  ['leboncoin.fr', 'leboncoin <messagerie@leboncoin.fr>', ['Nouveau message', 'Votre annonce est en ligne']],
  ['ameli.fr', 'Assurance Maladie <info@ameli.fr>', ['Relevé de remboursements', 'Attestation']],
  ['github.com', 'GitHub <notifications@github.com>', ['[repo] Nouvelle issue', 'Security alert']],
  ['outlook.fr', 'Dominique <dominique@outlook.fr>', ['Re: projet maison', 'Plans de la cuisine']],
];
const FILES: [string, string, number][] = [
  ['IMG_2481.jpg', 'image/jpeg', 3],
  ['photo.heic', 'image/heic', 2],
  ['facture.pdf', 'application/pdf', 0.4],
  ['contrat.pdf', 'application/pdf', 2.5],
  ['budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 0.8],
  ['video_anniv.mp4', 'video/mp4', 14],
  ['photos.zip', 'application/zip', 9],
  ['memo.m4a', 'audio/mp4', 3],
  ['plan.dwg', 'application/octet-stream', 4],
];
const CATEGORIES = ['CATEGORY_PERSONAL', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'];
const MB = 1024 * 1024;

/** Remplit le faux compte d'une boîte fictive et reproductible (mêmes données pour une même graine). */
export function seedMailbox(fake: FakeGoogle, count: number, seed = 42): void {
  let state = seed;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const now = Date.now();

  for (let index = 0; index < count; index++) {
    const [, from, subjects] = pick(SENDERS);
    const personal = from.includes('gmail.com') || from.includes('outlook.fr');
    const subject = pick(subjects);
    const last = now - Math.floor(random() ** 1.6 * 6 * 365) * 24 * 3600 * 1000;
    const length = 1 + Math.floor(random() ** 3 * (personal ? 8 : 3));
    const folder = random() < 0.5 ? [pick(['Label_1', 'Label_2', 'Label_3', 'Label_4'])] : [];
    const trashed = random() < 0.04;
    const category = pick(CATEGORIES);

    const messages = Array.from({ length }, (_, position) => {
      const mine = personal && position % 2 === 1;
      const withFiles = random() < 0.4;
      const attachments = withFiles
        ? Array.from({ length: 1 + Math.floor(random() ** 2 * 5) }, () => {
            const [name, mimeType, megabytes] = pick(FILES);
            return { name, mimeType, size: Math.floor(megabytes * MB * (0.3 + random())) };
          })
        : [];
      const labels = trashed ? ['TRASH'] : mine ? ['SENT'] : ['INBOX', category, ...folder, ...(random() < 0.2 ? ['IMPORTANT'] : [])];
      return fakeMessage({
        from: mine ? 'Moi <moi@example.com>' : from,
        to: mine ? from : personal && random() < 0.3 ? 'moi@example.com, dominique@outlook.fr' : 'moi@example.com',
        subject: position === 0 ? subject : `Re: ${subject}`,
        listId: personal ? undefined : `<${from.slice(from.indexOf('@') + 1, -1)}>`,
        labels,
        size: 8000 + Math.floor(random() * 60000) + Math.floor(attachments.reduce((sum, file) => sum + file.size, 0) * 1.37),
        date: last - (length - 1 - position) * 36 * 3600 * 1000,
        attachments,
      });
    });
    fake.addThread(`t${index.toString(16).padStart(6, '0')}`, messages);
  }
}

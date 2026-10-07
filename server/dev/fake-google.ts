import {
  canReadGmail,
  canReadDrive,
  canWriteDrive,
  canWriteGmail,
  DRIVE_FOLDER,
  MissingScopeError,
  NotFoundError,
  SCOPES,
  type DriveApi,
  type GmailApi,
  type GoogleGateway,
  type GoogleProfile,
  type GoogleTokens,
  type RawDriveFile,
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
  /** Fichiers et dossiers du faux Drive, par identifiant ; la racine « Mon Drive » est `root`. */
  files = new Map<string, RawDriveFile>();
  driveCalls = { list: 0, trash: 0, untrash: 0, delete: 0 };
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

  /** Ajoute un fichier dont le compte est propriétaire, à la racine par défaut. */
  addFile(id: string, file: Partial<RawDriveFile> & { size?: number } = {}): RawDriveFile {
    const { size = 1000, ...rest } = file;
    const added: RawDriveFile = {
      id,
      name: id,
      mimeType: 'application/pdf',
      quotaBytesUsed: String(size),
      parents: ['root'],
      trashed: false,
      modifiedTime: '2024-01-01T00:00:00.000Z',
      ownedByMe: true,
      ...rest,
    };
    this.files.set(id, added);
    return added;
  }

  addFolder(id: string, name: string, parent = 'root', ownedByMe = true): RawDriveFile {
    return this.addFile(id, { name, mimeType: DRIVE_FOLDER, parents: [parent], size: 0, ownedByMe });
  }

  drive(tokens: GoogleTokens): DriveApi {
    if (!canReadDrive(tokens)) throw new MissingScopeError('Lecture de Drive non autorisée');
    const write = async (id: string): Promise<RawDriveFile> => {
      if (!canWriteDrive(tokens)) throw new MissingScopeError('Modification de Drive non autorisée');
      await this.#before();
      if (this.refused.has(id)) throw Object.assign(new Error('Drive refuse cette opération'), { response: { status: 403 } });
      const file = this.files.get(id);
      if (!file) throw new NotFoundError('fichier supprimé');
      return file;
    };
    return {
      rootId: async () => {
        await this.#before();
        return 'root';
      },
      listFiles: async (pageToken) => {
        await this.#before();
        this.driveCalls.list++;
        // Comme Drive : vos fichiers, et tous les dossiers visibles.
        const visible = [...this.files.values()].filter((file) => file.ownedByMe !== false || file.mimeType === DRIVE_FOLDER);
        const start = Number(pageToken ?? 0);
        return {
          files: visible.slice(start, start + this.pageSize),
          nextPageToken: start + this.pageSize < visible.length ? String(start + this.pageSize) : undefined,
        };
      },
      trashFile: async (id) => {
        (await write(id)).trashed = true;
        this.driveCalls.trash++;
      },
      untrashFile: async (id) => {
        (await write(id)).trashed = false;
        this.driveCalls.untrash++;
      },
      deleteFile: async (id) => {
        await write(id);
        this.files.delete(id);
        this.driveCalls.delete++;
      },
    };
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

const DRIVE_FOLDERS: [string, string[]][] = [
  ['Photos', ['2021', '2022', '2023', 'Vacances en Crète']],
  ['Vidéos', ['Famille', 'Montages']],
  ['Administratif', ['Impôts', 'Banque', 'Logement']],
  ['Travail', ['Projets', 'Archives', 'Présentations']],
  ['Sauvegardes', ['Téléphone', 'Ancien ordinateur']],
  ['Musique', []],
];
const DRIVE_FILES: Record<string, [string, string, number][]> = {
  Photos: [['IMG_{n}.jpg', 'image/jpeg', 4], ['IMG_{n}.heic', 'image/heic', 2.5], ['pano_{n}.png', 'image/png', 9]],
  Vidéos: [['VID_{n}.mp4', 'video/mp4', 60], ['clip_{n}.mov', 'video/quicktime', 25]],
  Administratif: [['avis_{n}.pdf', 'application/pdf', 0.6], ['releve_{n}.pdf', 'application/pdf', 0.3], ['bail_{n}.pdf', 'application/pdf', 3]],
  Travail: [
    ['rapport_{n}.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1.2],
    ['budget_{n}.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 0.8],
    ['Notes {n}', 'application/vnd.google-apps.document', 0],
    ['support_{n}.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 14],
  ],
  Sauvegardes: [['sauvegarde_{n}.zip', 'application/zip', 80], ['export_{n}.tar.gz', 'application/gzip', 30]],
  Musique: [['piste_{n}.mp3', 'audio/mpeg', 7], ['concert_{n}.flac', 'audio/flac', 38]],
};

/** Remplit le faux Drive d'une arborescence fictive et reproductible. */
export function seedDrive(fake: FakeGoogle, count: number, seed = 7): void {
  let state = seed;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!;
  const now = Date.now();

  const folders: { id: string; top: string }[] = [];
  DRIVE_FOLDERS.forEach(([top, children], index) => {
    fake.addFolder(`d${index}`, top);
    folders.push({ id: `d${index}`, top });
    children.forEach((child, position) => {
      fake.addFolder(`d${index}-${position}`, child, `d${index}`);
      folders.push({ id: `d${index}-${position}`, top });
    });
  });
  // Un dossier partagé par quelqu'un d'autre, où le compte a déposé des fichiers à lui.
  fake.addFolder('d-partage', 'Projet commun', 'ailleurs', false);
  folders.push({ id: 'd-partage', top: 'Travail' });

  for (let index = 0; index < count; index++) {
    const folder = random() < 0.04 ? { id: 'root', top: pick(Object.keys(DRIVE_FILES)) } : pick(folders);
    const [pattern, mimeType, megabytes] = pick(DRIVE_FILES[folder.top]!);
    fake.addFile(`f${index.toString(16).padStart(5, '0')}`, {
      name: pattern.replace('{n}', String(1000 + index)),
      mimeType,
      size: Math.floor(megabytes * MB * (0.2 + random() * 1.6)),
      parents: [folder.id],
      trashed: random() < 0.03,
      shared: random() < 0.08,
      starred: random() < 0.02,
      modifiedTime: new Date(now - Math.floor(random() ** 1.5 * 7 * 365) * 24 * 3600 * 1000).toISOString(),
      webViewLink: 'https://drive.google.com/',
    });
  }
}

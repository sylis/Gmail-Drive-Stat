import type { RawGmailMessage, RawGmailPart } from '../google.js';

export type AttType = 'img' | 'vid' | 'pdf' | 'doc' | 'zip' | 'aud' | 'oth';
/** Zone d'affichage : reçus (treemap principal), envoyés et brouillons, corbeille et spam. */
export type Zone = 'inbox' | 'sent' | 'trash';

export interface ParsedAttachment {
  name: string;
  type: AttType;
  size: number;
}

export interface ParsedMessage {
  id: string;
  threadId: string;
  size: number;
  /** Date de réception selon Gmail, en millisecondes. */
  date: number;
  fromAddr: string;
  fromName: string;
  fromDomain: string;
  /** Destinataires À et Cc, dédoublonnés et triés : deux messages du même groupe ont la même valeur. */
  rcpt: string;
  subject: string;
  /** Identifiant de liste de diffusion, vide hors liste. */
  listId: string;
  labelIds: string[];
  zone: Zone;
  /** null quand la structure du message n'a pas été lue. */
  attachments: ParsedAttachment[] | null;
}

/** Décode les mots encodés RFC 2047 (=?utf-8?B?…?=) qui subsistent dans un en-tête. */
export function decodeHeader(value: string): string {
  return value
    .replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, '$1')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (whole, charset: string, encoding: string, text: string) => {
      try {
        const bytes =
          encoding.toLowerCase() === 'b'
            ? Buffer.from(text, 'base64')
            : Buffer.from(
                text.replace(/_/g, ' ').replace(/=([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16))),
                'latin1',
              );
        return new TextDecoder(charset).decode(bytes);
      } catch {
        return whole;
      }
    });
}

/** Découpe une liste d'adresses sur les virgules situées hors guillemets et hors chevrons. */
function splitAddresses(value: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  let depth = 0;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') depth++;
    else if (!quoted && char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && !quoted && depth === 0) {
      parts.push(current);
      current = '';
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

export function parseAddress(value: string): { addr: string; name: string } {
  const decoded = decodeHeader(value).trim();
  const bracket = /<([^<>]*)>\s*$/.exec(decoded);
  const addr = (bracket ? bracket[1]! : decoded).trim().toLowerCase();
  const name = bracket ? decoded.slice(0, bracket.index).trim().replace(/^"(.*)"$/, '$1').trim() : '';
  return { addr, name };
}

const SECOND_LEVEL = new Set(['co', 'com', 'gouv', 'gov', 'ac', 'org', 'net', 'edu', 'asso']);

/** Domaine d'envoi regroupé : news.site.fr et site.fr donnent site.fr, impots.gouv.fr reste entier. */
export function mainDomain(addr: string): string {
  const host = addr.slice(addr.lastIndexOf('@') + 1).replace(/[^a-z0-9.-]/g, '');
  const labels = host.split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const tld = labels.at(-1)!;
  const keep = tld.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-keep).join('.');
}

const EXTENSIONS: Record<AttType, string[]> = {
  img: ['jpg', 'jpeg', 'png', 'gif', 'heic', 'heif', 'webp', 'bmp', 'tif', 'tiff', 'svg', 'raw', 'psd'],
  vid: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'mpg', 'mpeg', '3gp'],
  aud: ['mp3', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'wma', 'amr', 'opus'],
  pdf: ['pdf'],
  zip: ['zip', 'rar', '7z', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'iso'],
  doc: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'csv', 'txt', 'rtf', 'pages', 'numbers', 'key'],
  oth: [],
};
const BY_EXTENSION = new Map(
  (Object.entries(EXTENSIONS) as [AttType, string[]][]).flatMap(([type, list]) => list.map((ext) => [ext, type] as const)),
);

export function attachmentType(mimeType: string, filename: string): AttType {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith('image/')) return 'img';
  if (mime.startsWith('video/')) return 'vid';
  if (mime.startsWith('audio/')) return 'aud';
  if (mime === 'application/pdf') return 'pdf';
  const byExtension = BY_EXTENSION.get(filename.slice(filename.lastIndexOf('.') + 1).toLowerCase());
  if (byExtension) return byExtension;
  if (/zip|compressed|x-tar|x-rar/.test(mime)) return 'zip';
  if (/msword|officedocument|opendocument|ms-excel|ms-powerpoint|^text\//.test(mime)) return 'doc';
  return 'oth';
}

function collectAttachments(part: RawGmailPart | undefined, into: ParsedAttachment[]): ParsedAttachment[] {
  if (!part) return into;
  if (part.filename) {
    const name = decodeHeader(part.filename);
    into.push({ name, type: attachmentType(part.mimeType ?? '', name), size: part.body?.size ?? 0 });
  }
  for (const child of part.parts ?? []) collectAttachments(child, into);
  return into;
}

/** Zone d'un message d'après ses libellés : la corbeille l'emporte, puis les envois. */
export function zoneOf(labelIds: string[]): Zone {
  if (labelIds.includes('TRASH') || labelIds.includes('SPAM')) return 'trash';
  return labelIds.includes('SENT') || labelIds.includes('DRAFT') ? 'sent' : 'inbox';
}

export function parseMessage(raw: RawGmailMessage, detail: boolean): ParsedMessage {
  const headers = new Map<string, string>();
  for (const header of raw.payload?.headers ?? []) {
    const name = header.name.toLowerCase();
    if (!headers.has(name)) headers.set(name, header.value);
  }
  const from = parseAddress(headers.get('from') ?? '');
  const recipients = new Set(
    [headers.get('to'), headers.get('cc')]
      .flatMap((value) => (value ? splitAddresses(value) : []))
      .map((value) => parseAddress(value).addr)
      .filter((addr) => addr.includes('@')),
  );
  const listHeader = headers.get('list-id');
  const listId = listHeader
    ? (/<([^<>]+)>/.exec(listHeader)?.[1] ?? listHeader).trim().toLowerCase()
    : headers.has('list-unsubscribe')
      ? from.addr
      : '';
  const labelIds = raw.labelIds ?? [];

  return {
    id: raw.id,
    threadId: raw.threadId,
    size: raw.sizeEstimate ?? 0,
    date: Number(raw.internalDate ?? 0),
    fromAddr: from.addr,
    fromName: from.name,
    fromDomain: mainDomain(from.addr),
    rcpt: [...recipients].sort().join(', '),
    subject: decodeHeader(headers.get('subject') ?? '').trim(),
    listId,
    labelIds,
    zone: zoneOf(labelIds),
    attachments: detail ? collectAttachments(raw.payload, []) : null,
  };
}

import { mainDomain, type AttType, type Zone } from './parse.js';

/** Ce qu'il faut connaître d'un message pour ranger sa conversation. */
export interface BrickMessage {
  zone: Zone;
  size: number;
  date: number;
  fromAddr: string;
  fromDomain: string;
  rcpt: string;
  subject: string;
  listId: string;
  labelIds: string[];
  /** null quand les pièces jointes n'ont pas été lues. */
  attachments: { type: AttType; size: number }[] | null;
}

export type AttBucket = '0' | '1' | '2-5' | '6+' | 'unk';

/**
 * Une brique du treemap : les messages d'une conversation situés dans une même zone.
 * Chaque axe de regroupement lui donne une seule place, pour que la somme des blocs égale l'espace réel.
 */
export interface Brick {
  zone: Zone;
  size: number;
  msgs: number;
  date: number;
  year: number;
  quarter: number;
  month: number;
  domain: string;
  sender: string;
  label: string;
  category: string;
  list: string;
  rcpt: string;
  /** null si aucune pièce jointe n'a été lue dans la brique. */
  attCount: number | null;
  attBucket: AttBucket;
  /** Type de la plus grosse pièce jointe ; 'none' sans pièce jointe, 'unk' si non lu. */
  attType: AttType | 'none' | 'unk';
  subject: string;
  /** Un message au moins est marqué important ou suivi. */
  flagged: boolean;
}

const SYSTEM_LABELS: Record<string, string> = {
  INBOX: 'Boîte de réception',
  TRASH: 'Corbeille',
  SPAM: 'Spam',
  DRAFT: 'Brouillons',
  CHAT: 'Chats',
};

const CATEGORIES: Record<string, string> = {
  CATEGORY_PERSONAL: 'Principale',
  CATEGORY_PROMOTIONS: 'Promotions',
  CATEGORY_SOCIAL: 'Réseaux sociaux',
  CATEGORY_UPDATES: 'Notifications',
  CATEGORY_FORUMS: 'Forums',
};

// États d'un message plutôt que rangements : ils ne servent pas d'axe « libellé ». Envoyés a sa propre zone.
const NOT_A_FOLDER = new Set(['SENT', 'UNREAD', 'IMPORTANT', 'STARRED', ...Object.keys(CATEGORIES)]);

export const labelDisplayName = (id: string, name: string) => SYSTEM_LABELS[id] ?? name;

function tally(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** Valeur la plus fréquente ; `rank` départage les égalités (le plus grand gagne), puis l'ordre alphabétique. */
function mostFrequent(counts: Map<string, number>, rank: (value: string) => number = () => 0): string {
  let best = '';
  let bestCount = 0;
  let bestRank = 0;
  for (const [value, count] of counts) {
    const valueRank = rank(value);
    const wins =
      count > bestCount ||
      (count === bestCount && (valueRank > bestRank || (valueRank === bestRank && value.localeCompare(best) < 0)));
    if (wins) [best, bestCount, bestRank] = [value, count, valueRank];
  }
  return best;
}

function bucket(count: number): AttBucket {
  return count === 0 ? '0' : count === 1 ? '1' : count <= 5 ? '2-5' : '6+';
}

export function computeBricks(thread: BrickMessage[], labelName: (id: string) => string | undefined): Brick[] {
  if (thread.length === 0) return [];
  // La conversation est datée de son dernier message, quelle que soit la zone.
  const date = Math.max(...thread.map((message) => message.date));
  const when = new Date(date);
  const month = when.getUTCMonth() + 1;

  // Domaines cités dans toute la conversation, pour départager deux domaines qui ont envoyé autant de messages.
  const cited = tally(
    thread.flatMap((message) => [message.fromAddr, ...message.rcpt.split(', ')]).map((addr) => mainDomain(addr)),
  );

  const bricks: Brick[] = [];
  for (const zone of ['inbox', 'sent', 'trash'] as const) {
    const messages = thread.filter((message) => message.zone === zone);
    if (messages.length === 0) continue;

    const labels = tally(messages.flatMap((message) => message.labelIds.filter((id) => !NOT_A_FOLDER.has(id))));
    const labelId = mostFrequent(labels, (id) => (id in SYSTEM_LABELS ? 0 : 1));
    const categoryId = mostFrequent(tally(messages.flatMap((message) => message.labelIds.filter((id) => id in CATEGORIES))));

    const known = messages.flatMap((message) => message.attachments ?? []);
    const allRead = messages.every((message) => message.attachments !== null);
    const biggest = known.reduce<(typeof known)[number] | null>((max, att) => (!max || att.size > max.size ? att : max), null);
    const unread = !allRead && known.length === 0;

    const first = messages.reduce((oldest, message) => (message.date < oldest.date ? message : oldest));
    bricks.push({
      zone,
      size: messages.reduce((sum, message) => sum + message.size, 0),
      msgs: messages.length,
      date,
      year: when.getUTCFullYear(),
      quarter: Math.ceil(month / 3),
      month,
      domain: mostFrequent(tally(messages.map((message) => message.fromDomain)), (domain) => cited.get(domain) ?? 0),
      sender: mostFrequent(tally(messages.map((message) => message.fromAddr))),
      label: labelId ? labelDisplayName(labelId, labelName(labelId) ?? labelId) : '',
      category: CATEGORIES[categoryId] ?? '',
      list: mostFrequent(tally(messages.map((message) => message.listId))),
      rcpt: mostFrequent(tally(messages.map((message) => message.rcpt))),
      attCount: unread ? null : known.length,
      attBucket: unread ? 'unk' : bucket(known.length),
      attType: unread ? 'unk' : (biggest?.type ?? 'none'),
      subject: first.subject,
      flagged: messages.some((message) => message.labelIds.includes('IMPORTANT') || message.labelIds.includes('STARRED')),
    });
  }
  return bricks;
}

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeMessage, seedMailbox } from '../dev/fake-google.ts';
import { computeBricks, type BrickMessage } from '../src/gmail/bricks.ts';
import { attachmentType, decodeHeader, mainDomain, parseAddress, parseMessage } from '../src/gmail/parse.ts';
import type { TreeNode } from '../src/gmail/queries.ts';
import { GmailScanner } from '../src/gmail/scanner.ts';
import { parseScope, scopeQuery, type ScanScope } from '../src/gmail/scope.ts';
import { ReauthRequiredError, RetryLaterError } from '../src/google.ts';
import { setup } from './helpers.ts';

const MB = 1024 * 1024;
const ALL: ScanScope = { period: { kind: 'all' }, labelIds: [], minSizeMb: 0, attachmentDetail: 'large' };

test('les en-têtes sont décodés et les adresses normalisées', () => {
  assert.equal(decodeHeader('=?UTF-8?B?UsOpdW5pb24=?= =?utf-8?Q?d=27=C3=A9t=C3=A9?='), "Réuniond'été");
  assert.deepEqual(parseAddress('"Dupont, Camille" <Camille.Dupont@Gmail.com>'), { addr: 'camille.dupont@gmail.com', name: 'Dupont, Camille' });
  assert.deepEqual(parseAddress('seul@site.fr'), { addr: 'seul@site.fr', name: '' });
  assert.equal(mainDomain('a@news.site.fr'), 'site.fr');
  assert.equal(mainDomain('a@dgfip.impots.gouv.fr'), 'impots.gouv.fr');
  assert.equal(mainDomain('a@mail.shop.co.uk'), 'shop.co.uk');
});

test('le type d’une pièce jointe vient du type MIME, sinon de l’extension', () => {
  assert.equal(attachmentType('image/jpeg', 'a.jpg'), 'img');
  assert.equal(attachmentType('application/octet-stream', 'film.MOV'), 'vid');
  assert.equal(attachmentType('application/octet-stream', 'archive.7z'), 'zip');
  assert.equal(attachmentType('application/vnd.ms-excel', 'budget'), 'doc');
  assert.equal(attachmentType('application/octet-stream', 'plan.dwg'), 'oth');
});

test('un message est rangé dans sa zone avec ses destinataires et ses pièces jointes', () => {
  const raw = {
    id: 'm1',
    threadId: 't1',
    ...fakeMessage({
      from: 'Liste <info@news.site.fr>',
      to: 'Zoé <zoe@a.fr>, "B, Al" <al@b.fr>',
      cc: 'al@b.fr',
      listId: 'Infos <infos.site.fr>',
      size: 5 * MB,
      date: 1700000000000,
      attachments: [{ name: 'a.pdf', mimeType: 'application/pdf', size: 4 * MB }],
    }),
  };
  const detailed = parseMessage(raw, true);
  assert.equal(detailed.fromDomain, 'site.fr');
  assert.equal(detailed.rcpt, 'al@b.fr, zoe@a.fr');
  assert.equal(detailed.listId, 'infos.site.fr');
  assert.equal(detailed.zone, 'inbox');
  assert.deepEqual(detailed.attachments, [{ name: 'a.pdf', type: 'pdf', size: 4 * MB }]);
  assert.equal(parseMessage(raw, false).attachments, null);
  assert.equal(parseMessage({ ...raw, labelIds: ['SENT', 'INBOX'] }, false).zone, 'sent');
  assert.equal(parseMessage({ ...raw, labelIds: ['SENT', 'TRASH'] }, false).zone, 'trash');
});

const message = (over: Partial<BrickMessage>): BrickMessage => ({
  zone: 'inbox',
  size: 100,
  date: Date.UTC(2023, 4, 2),
  fromAddr: 'a@x.fr',
  fromDomain: 'x.fr',
  rcpt: 'moi@example.com',
  subject: 'Sujet',
  listId: '',
  labelIds: ['INBOX'],
  attachments: [],
  ...over,
});

test('une conversation a une seule place par axe', () => {
  const bricks = computeBricks(
    [
      message({ date: Date.UTC(2023, 2, 30), fromAddr: 'a@x.fr', fromDomain: 'x.fr', labelIds: ['INBOX', 'Label_1'], subject: 'Premier' }),
      message({ fromAddr: 'b@y.fr', fromDomain: 'y.fr', labelIds: ['Label_1', 'CATEGORY_UPDATES', 'IMPORTANT'] }),
      message({ fromAddr: 'c@y.fr', fromDomain: 'y.fr', labelIds: ['Label_1'], attachments: [{ type: 'img', size: 10 }, { type: 'vid', size: 90 }] }),
      message({ zone: 'sent', date: Date.UTC(2023, 6, 1), fromAddr: 'moi@example.com', fromDomain: 'example.com', labelIds: ['SENT'], size: 40 }),
    ],
    (id) => (id === 'Label_1' ? 'Achats' : undefined),
  );
  const [inbox, sent] = bricks;
  assert.equal(bricks.length, 2);
  // Datée du dernier message de toute la conversation, ici l'envoi de juillet.
  assert.deepEqual([inbox!.year, inbox!.quarter, inbox!.month], [2023, 3, 7]);
  assert.equal(inbox!.domain, 'y.fr');
  assert.equal(inbox!.label, 'Achats');
  assert.equal(inbox!.category, 'Notifications');
  assert.equal(inbox!.size, 300);
  assert.equal(inbox!.attType, 'vid');
  assert.equal(inbox!.attBucket, '2-5');
  assert.equal(inbox!.subject, 'Premier');
  assert.equal(inbox!.flagged, true);
  assert.deepEqual([sent!.zone, sent!.size, sent!.label], ['sent', 40, '']);
});

test('à égalité de messages, le domaine le plus cité l’emporte ; sans lecture des pièces jointes, le type reste inconnu', () => {
  const [brick] = computeBricks(
    [
      message({ fromAddr: 'a@x.fr', fromDomain: 'x.fr', rcpt: 'b@y.fr, c@y.fr', attachments: null }),
      message({ fromAddr: 'b@y.fr', fromDomain: 'y.fr', rcpt: 'a@x.fr', attachments: null }),
    ],
    () => undefined,
  );
  assert.equal(brick!.domain, 'y.fr');
  assert.deepEqual([brick!.attType, brick!.attBucket, brick!.attCount], ['unk', 'unk', null]);
  assert.equal(brick!.label, 'Boîte de réception');
});

test('le périmètre est validé puis traduit en recherche Gmail', () => {
  assert.equal(parseScope({ period: { kind: 'days', days: 0 }, attachmentDetail: 'all' }), null);
  assert.equal(parseScope({ period: { kind: 'range', from: '2019-13-01' }, attachmentDetail: 'all' }), null);
  assert.equal(parseScope({ period: { kind: 'all' }, attachmentDetail: 'tout' }), null);
  const scope = parseScope({ period: { kind: 'range', from: '2019-01-01', to: '2024-12-31' }, minSizeMb: 1, attachmentDetail: 'large' })!;
  assert.equal(scopeQuery(scope), 'after:2019/01/01 before:2025/01/01 larger:1M');
  assert.equal(scopeQuery({ ...ALL, period: { kind: 'days', days: 90 } }), 'newer_than:90d');
  assert.equal(scopeQuery(ALL), '');
});

/** Somme des briques et des restes d'un arbre : doit toujours retomber sur le total de la racine. */
function leafTotal(node: TreeNode): number {
  if (node.children) return node.children.reduce((sum, child) => sum + leafTotal(child), 0);
  if (!node.bricks) return node.v;
  return node.bricks.reduce((sum, brick) => sum + brick.v, 0) + (node.rest?.v ?? 0);
}

async function scanned(count = 120) {
  const context = await setup();
  seedMailbox(context.fake, count);
  const cookies = await context.login();
  const start = await context.post('/api/gmail/scan', cookies, { scope: ALL });
  assert.equal(start.statusCode, 200);
  await context.scanner.idle();
  return { ...context, cookies };
}

test('un scan lit toute la boîte, page par page, puis détaille les gros messages', async () => {
  const { app, fake, cookies } = await scanned(250);
  const state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(state.scan.status, 'done');
  assert.equal(state.scan.threadsDone, 250);
  assert.equal(state.summary.conversations, 250);
  assert.ok(fake.calls.listThreads >= 3, 'la liste est paginée');
  assert.equal(fake.calls.getThread, 250);

  const all = [...fake.threads.values()].flatMap((thread) => thread.messages);
  assert.equal(state.scan.stats.messagesRead, all.length);
  assert.equal(state.scan.stats.bytesRead, all.reduce((sum, m) => sum + m.sizeEstimate!, 0));
  // Seuls les messages d'au moins 1 Mo sont relus pour le détail de leurs pièces jointes.
  const large = all.filter((m) => m.sizeEstimate! >= MB);
  assert.equal(fake.calls.getMessage, large.length);
  assert.equal(state.scan.stats.detailDone, large.length);
  const sizes = state.summary.inbox.size + state.summary.sent.size + state.summary.trash.size;
  assert.equal(sizes, state.scan.stats.bytesRead);
  assert.deepEqual(state.scopes.map((entry: { scope: ScanScope }) => entry.scope), [ALL]);
});

test('le treemap retombe sur l’espace réel, quels que soient les niveaux, le zoom et les filtres', async () => {
  const { app, post, cookies } = await scanned();
  const summary = (await app.inject({ url: '/api/gmail/state', cookies })).json().summary;

  const byPeriod = (await post('/api/gmail/treemap', cookies, { levels: ['year', 'quarter', 'domain'] })).json();
  assert.equal(byPeriod.tree.v, summary.inbox.size);
  assert.equal(byPeriod.tree.c, summary.inbox.conversations);
  assert.equal(leafTotal(byPeriod.tree), summary.inbox.size);
  assert.equal(byPeriod.sent.v, summary.sent.size);
  assert.equal(byPeriod.trash.v, summary.trash.size);

  for (const levels of [['label'], ['attType', 'sender'], []]) {
    const { tree } = (await post('/api/gmail/treemap', cookies, { levels })).json();
    assert.equal(leafTotal(tree), summary.inbox.size, `niveaux ${levels.join(' > ')}`);
  }

  // Zoomer sur un bloc renvoie exactement ce bloc.
  const year = byPeriod.tree.children[0];
  const zoomed = (await post('/api/gmail/treemap', cookies, { levels: ['year', 'quarter', 'domain'], path: [year.k] })).json();
  assert.equal(zoomed.tree.v, year.v);
  assert.equal(zoomed.tree.children.length, year.children.length);

  // Un filtre restreint le treemap ; les valeurs proposées pour l'axe filtré restent complètes.
  const facet = (await post('/api/gmail/facet', cookies, { axis: 'domain' })).json().values;
  assert.equal(facet.reduce((sum: number, entry: { size: number }) => sum + entry.size, 0), summary.inbox.size);
  const filters = { axes: { domain: { values: [facet[0].value] } } };
  const filtered = (await post('/api/gmail/treemap', cookies, { levels: ['year'], filters })).json();
  assert.equal(filtered.tree.v, facet[0].size);
  assert.equal((await post('/api/gmail/facet', cookies, { axis: 'domain', filters })).json().values.length, facet.length);
  const excluded = (await post('/api/gmail/treemap', cookies, { levels: [], filters: { axes: { domain: { values: [facet[0].value], exclude: true } } } })).json();
  assert.equal(excluded.tree.v, summary.inbox.size - facet[0].size);

  assert.equal((await post('/api/gmail/treemap', cookies, { levels: ['year', 'year'] })).statusCode, 400);
  assert.equal((await post('/api/gmail/treemap', cookies, { levels: ['date; DROP TABLE'] })).statusCode, 400);
});

test('la liste triée, le détail d’une conversation et les plus grosses pièces jointes', async () => {
  const { app, post, cookies } = await scanned();
  const list = (await post('/api/gmail/list', cookies, { levels: [] })).json();
  assert.ok(list.total > 100);
  const sizes = list.rows.map((row: { size: number }) => row.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));

  const top = list.rows[0];
  const detail = (await app.inject({ url: `/api/gmail/conversations/${top.id}?zone=inbox`, cookies })).json();
  assert.equal(detail.size, top.size);
  assert.equal(detail.messages.length, top.msgs);
  assert.equal(detail.messages.reduce((sum: number, m: { size: number }) => sum + m.size, 0), top.size);
  assert.equal((await app.inject({ url: '/api/gmail/conversations/inconnue', cookies })).statusCode, 404);

  const { attachments } = (await post('/api/gmail/attachments', cookies)).json();
  assert.ok(attachments.length > 0);
  assert.ok(attachments[0].size >= attachments.at(-1).size);
  assert.ok(attachments.every((a: { zone: string }) => a.zone !== 'trash'));
});

test('un nouveau scan ne relit que ce qui a changé et retire ce qui a disparu', async () => {
  const { fake, post, scanner, cookies, app } = await scanned(60);
  const [first, second] = [...fake.threads.keys()];
  fake.calls.getThread = 0;
  fake.touch(first!);
  fake.threads.delete(second!);
  fake.addThread('nouvelle', [fakeMessage({ subject: 'Toute neuve' })]);

  await post('/api/gmail/scan', cookies, { scope: ALL });
  await scanner.idle();
  assert.equal(fake.calls.getThread, 2, 'la conversation modifiée et la nouvelle');
  const state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(state.summary.conversations, 60);
  assert.equal((await app.inject({ url: `/api/gmail/conversations/${second}`, cookies })).statusCode, 404);
  assert.equal((await app.inject({ url: '/api/gmail/conversations/nouvelle', cookies })).json().subject, 'Toute neuve');
});

test('un scan limité aux gros messages lit leurs conversations en entier', async () => {
  const { fake, login, post, scanner, app } = await setup();
  fake.addThread('grosse', [fakeMessage({ size: 3 * MB }), fakeMessage({ size: 500 })]);
  fake.addThread('petite', [fakeMessage({ size: 900 })]);
  const cookies = await login();
  await post('/api/gmail/scan', cookies, { scope: { ...ALL, minSizeMb: 1 } });
  await scanner.idle();
  const { summary } = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.deepEqual(summary.inbox, { conversations: 1, messages: 2, size: 3 * MB + 500 });
});

test('le scan patiente quand Google demande de ralentir, puis reprend seul', async () => {
  const { fake, login, post, scanner, app } = await setup();
  seedMailbox(fake, 30);
  const cookies = await login();
  fake.failures.push(new RetryLaterError('429'), new RetryLaterError('429'), new RetryLaterError('503'));
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await scanner.idle();
  const { scan, summary } = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(scan.status, 'done');
  assert.equal(summary.conversations, 30);
});

test('une autorisation expirée suspend le scan, la reconnexion le relance', async () => {
  const { fake, login, post, scanner, app } = await setup();
  seedMailbox(fake, 40);
  const cookies = await login();
  fake.latencyMs = 1;
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await new Promise((resolve) => setTimeout(resolve, 30));
  fake.failures.push(new ReauthRequiredError('expirée'));
  await scanner.idle();

  let state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(state.scan.status, 'auth');
  assert.equal((await app.inject({ url: '/api/status', cookies })).json().needsReauth, true);
  assert.ok(state.scan.threadsDone < 40);

  const before = fake.calls.getThread;
  await login();
  await scanner.idle();
  state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(state.scan.status, 'done');
  assert.equal(state.summary.conversations, 40);
  assert.ok(fake.calls.getThread - before <= 40 - state.scan.threadsDone + 40, 'les conversations déjà lues ne sont pas relues');
  assert.ok(fake.calls.getThread <= 40 + 8, 'reprise sans repartir de zéro');
});

test('pause, reprise et annulation ; un seul scan à la fois', async () => {
  const { fake, login, post, scanner, app } = await setup();
  seedMailbox(fake, 80);
  const cookies = await login();
  fake.latencyMs = 2;
  await post('/api/gmail/scan', cookies, { scope: ALL });
  assert.equal((await post('/api/gmail/scan', cookies, { scope: ALL })).statusCode, 409);
  assert.equal((await post('/api/gmail/scan', cookies, { scope: { period: {} } })).statusCode, 400);

  const paused = (await post('/api/gmail/scan/pause', cookies)).json().scan;
  assert.equal(paused.status, 'paused');
  const frozen = fake.calls.getThread;
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fake.calls.getThread, frozen, 'plus aucun appel pendant la pause');

  await post('/api/gmail/scan/resume', cookies);
  fake.latencyMs = 0;
  await scanner.idle();
  assert.equal((await app.inject({ url: '/api/gmail/state', cookies })).json().scan.status, 'done');
  assert.ok(fake.calls.getThread <= 80 + 8);

  // Annuler garde ce qui a déjà été lu ; tout effacer vide la base.
  fake.addThread('autre', [fakeMessage({})]);
  fake.latencyMs = 5;
  await post('/api/gmail/scan', cookies, { scope: ALL });
  assert.equal((await post('/api/gmail/scan/cancel', cookies)).json().scan.status, 'cancelled');
  assert.ok((await app.inject({ url: '/api/gmail/state', cookies })).json().summary.conversations >= 80);
  await post('/api/gmail/erase', cookies);
  const erased = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.deepEqual([erased.summary.conversations, erased.scan], [0, null]);
});

test('sans l’autorisation Gmail, le scan attend qu’elle soit accordée', async () => {
  const { fake, login, post, scanner, app } = await setup();
  fake.tokens = { ...fake.tokens, scope: 'openid email profile' };
  const cookies = await login();
  assert.equal((await app.inject({ url: '/api/gmail/state', cookies })).json().authorized, false);
  assert.equal((await app.inject({ url: '/api/gmail/mailbox', cookies })).statusCode, 403);
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await scanner.idle();
  const { scan } = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.deepEqual([scan.status, scan.error], ['auth', 'autorisation-incomplete']);
});

test('les données Gmail exigent une session et disparaissent avec le compte', async () => {
  const { app, db, post, cookies } = await scanned(20);
  assert.equal((await app.inject({ url: '/api/gmail/state' })).statusCode, 401);
  assert.equal((await post('/api/gmail/treemap', {}, { levels: [] })).statusCode, 401);
  await post('/api/account/revoke', cookies);
  for (const table of ['gmail_threads', 'gmail_messages', 'gmail_attachments', 'gmail_bricks', 'gmail_scans', 'gmail_labels']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
});

test('après un arrêt du serveur, le scan reprend où il s’était arrêté', async () => {
  const { fake, login, post, scanner, store, gmail, app } = await setup();
  seedMailbox(fake, 60);
  const cookies = await login();
  fake.latencyMs = 2;
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await scanner.shutdown();
  const stopped = (await app.inject({ url: '/api/gmail/state', cookies })).json().scan;
  assert.equal(stopped.status, 'running');
  assert.ok(stopped.threadsDone > 0 && stopped.threadsDone < 60);

  fake.latencyMs = 0;
  const restarted = new GmailScanner(store, gmail, fake, { unitsPerSecond: 1e9 });
  restarted.resumeInterrupted();
  await restarted.idle();
  const scan = gmail.latestScan(1)!;
  assert.equal(scan.status, 'done');
  assert.equal(gmail.queueCounts(scan.id).done, 60);
  assert.ok(fake.calls.getThread <= 60 + 8, 'les conversations déjà lues ne sont pas relues');
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeMessage, seedMailbox } from '../dev/fake-google.ts';
import type { ScanScope } from '../src/gmail/scope.ts';
import { NotFoundError, ReauthRequiredError } from '../src/google.ts';
import { setup } from './helpers.ts';

const ALL: ScanScope = { period: { kind: 'all' }, labelIds: [], minSizeMb: 0, attachmentDetail: 'all' };

/** Une petite boîte connue, déjà scannée : trois conversations reçues, dont une avec une réponse envoyée. */
async function mailbox() {
  const context = await setup();
  const { fake } = context;
  fake.addThread('a', [
    fakeMessage({ subject: 'Photos', size: 5000, labels: ['INBOX', 'UNREAD', 'IMPORTANT'] }),
    fakeMessage({ subject: 'Re: Photos', size: 700, labels: ['SENT'], from: 'Moi <moi@example.com>', to: 'camille@gmail.com' }),
    fakeMessage({ subject: 'Re: Photos', size: 3000, labels: ['INBOX'] }),
  ]);
  fake.addThread('b', [fakeMessage({ subject: 'Facture', size: 2000, labels: ['INBOX', 'Label_1'] })]);
  fake.addThread('c', [fakeMessage({ subject: 'Billet', size: 1000 })]);
  const cookies = await context.login();
  await context.post('/api/gmail/scan', cookies, { scope: ALL });
  await context.scanner.idle();

  const state = async () => (await context.app.inject({ url: '/api/gmail/state', cookies })).json();
  const labels = (thread: string) => fake.threads.get(thread)?.messages.map((message) => message.labelIds!.join(','));
  const run = async (body: object) => {
    const response = await context.post('/api/gmail/cleanup', cookies, body);
    await context.cleaner.idle();
    return response;
  };
  return { ...context, cookies, state, labels, run };
}

const inbox = (...ids: string[]) => ids.map((id) => ({ id, zone: 'inbox' }));

test('le récapitulatif vient de la base et signale les messages importants', async () => {
  const { post, cookies } = await mailbox();
  const preview = (await post('/api/gmail/cleanup/preview', cookies, { items: [...inbox('a', 'b', 'a', 'inconnue')] })).json();
  assert.deepEqual([preview.conversations, preview.messages, preview.size, preview.flagged], [2, 3, 10000, 1]);
  assert.deepEqual(preview.top[0], { subject: 'Photos', size: 8000, msgs: 2 });
  assert.equal((await post('/api/gmail/cleanup/preview', cookies, { items: [] })).statusCode, 400);
  assert.equal((await post('/api/gmail/cleanup/preview', cookies, { items: [{ id: 'a', zone: 'ailleurs' }] })).statusCode, 400);
});

test('la corbeille ne touche que les messages de la brique, puis se restaure', async () => {
  const { run, state, labels, fake, post, cookies, cleaner } = await mailbox();
  assert.equal((await run({ action: 'trash', items: inbox('a') })).statusCode, 200);

  // Les deux messages reçus partent à la corbeille ; la réponse envoyée ne bouge pas.
  assert.deepEqual(labels('a'), ['UNREAD,IMPORTANT,TRASH', 'SENT', 'TRASH']);
  assert.equal(fake.calls.trash, 2);
  let { summary, cleanup } = await state();
  assert.deepEqual([summary.inbox.size, summary.sent.size, summary.trash.size], [3000, 700, 8000]);
  assert.deepEqual([cleanup.action, cleanup.status, cleanup.counts.done.conversations, cleanup.counts.done.size], ['trash', 'done', 1, 8000]);
  assert.equal(cleanup.restorable, true);

  const restored = await post(`/api/gmail/cleanups/${cleanup.id}/restore`, cookies);
  assert.equal(restored.statusCode, 200);
  await cleaner.idle();
  // De retour dans la boîte de réception, comme avant.
  assert.deepEqual(labels('a'), ['UNREAD,IMPORTANT,INBOX', 'SENT', 'INBOX']);
  ({ summary, cleanup } = await state());
  assert.deepEqual([summary.inbox.size, summary.trash.size], [11000, 0]);
  assert.deepEqual([cleanup.action, cleanup.status, cleanup.restorable], ['untrash', 'done', false]);
  // Une mise à la corbeille ne se restaure qu'une fois.
  assert.equal((await post(`/api/gmail/cleanups/${cleanup.sourceId}/restore`, cookies)).statusCode, 409);
});

test('la suppression définitive exige de saisir le bon nombre de conversations', async () => {
  const { run, state, fake, app, cookies } = await mailbox();
  assert.equal((await run({ action: 'delete', items: inbox('a', 'b') })).statusCode, 400);
  assert.equal((await run({ action: 'delete', items: inbox('a', 'b'), confirm: 3 })).json().error, 'confirmation-requise');
  assert.equal(fake.calls.batchDelete, 0);
  assert.equal(fake.threads.size, 3);

  assert.equal((await run({ action: 'delete', items: inbox('a', 'b'), confirm: 2 })).statusCode, 200);
  assert.equal(fake.calls.batchDelete, 1, 'un seul appel groupé pour les deux conversations');
  assert.deepEqual([...fake.threads.keys()], ['a', 'c']);
  assert.deepEqual(fake.threads.get('a')!.messages.map((message) => message.labelIds), [['SENT']]);
  const { summary, cleanup } = await state();
  assert.deepEqual([summary.inbox.size, summary.sent.size, summary.conversations], [1000, 700, 2]);
  assert.equal(cleanup.restorable, false);
  assert.equal((await app.inject({ url: '/api/gmail/conversations/b', cookies })).statusCode, 404);

  // Le journal garde la trace de ce qui a été supprimé.
  const items = (await app.inject({ url: `/api/gmail/cleanups/${cleanup.id}/items`, cookies })).json().items;
  assert.deepEqual(items.map((item: { subject: string; state: string; size: number }) => [item.subject, item.state, item.size]), [
    ['Photos', 'done', 8000],
    ['Facture', 'done', 2000],
  ]);
});

test('la simulation n’envoie rien à Gmail et ne change rien en base', async () => {
  const { run, state, fake, app, cookies } = await mailbox();
  const before = (await state()).summary;
  assert.equal((await run({ action: 'delete', items: inbox('a', 'b', 'c'), confirm: 3, simulate: true })).statusCode, 200);
  assert.deepEqual([fake.calls.batchDelete, fake.calls.delete, fake.calls.trash, fake.threads.size], [0, 0, 0, 3]);
  const { summary, cleanup } = await state();
  assert.deepEqual(summary, before);
  assert.deepEqual([cleanup.simulate, cleanup.status, cleanup.counts.done.conversations, cleanup.counts.done.size], [true, 'done', 3, 11000]);
  const journal = (await app.inject({ url: '/api/gmail/cleanups', cookies })).json().cleanups;
  assert.deepEqual(journal.map((entry: { simulate: boolean }) => entry.simulate), [true]);
});

test('archiver, marquer lu et non lu changent les libellés sans rien supprimer', async () => {
  const { run, labels, app, cookies, fake } = await mailbox();
  await run({ action: 'archive', items: inbox('b') });
  assert.deepEqual(labels('b'), ['Label_1']);
  assert.equal((await app.inject({ url: '/api/gmail/conversations/b', cookies })).json().label, 'Achats');

  await run({ action: 'read', items: inbox('a') });
  assert.deepEqual(labels('a'), ['INBOX,IMPORTANT', 'SENT', 'INBOX']);
  await run({ action: 'unread', items: inbox('c') });
  assert.deepEqual(labels('c'), ['INBOX,UNREAD']);
  assert.equal(fake.threads.size, 3);
  assert.deepEqual([fake.calls.batchModify, fake.calls.trash, fake.calls.batchDelete], [3, 0, 0]);
});

test('un refus de Gmail laisse la conversation en place et se réessaie', async () => {
  const { run, state, fake, post, cookies, cleaner, app } = await mailbox();
  fake.refused.add('b-m0');
  await run({ action: 'trash', items: inbox('a', 'b', 'c') });
  let { summary, cleanup } = await state();
  assert.deepEqual([cleanup.status, cleanup.counts.done.conversations, cleanup.counts.failed.conversations], ['done', 2, 1]);
  assert.deepEqual([summary.inbox.size, summary.trash.size], [2000, 9000]);
  const failed = (await app.inject({ url: `/api/gmail/cleanups/${cleanup.id}/items?state=failed`, cookies })).json().items;
  assert.deepEqual(failed.map((item: { id: string; error: string }) => [item.id, item.error]), [['b', 'requete-refusee']]);

  fake.refused.clear();
  assert.equal((await post(`/api/gmail/cleanups/${cleanup.id}/retry`, cookies, { item: { id: 'b', zone: 'inbox' } })).statusCode, 200);
  await cleaner.idle();
  ({ summary, cleanup } = await state());
  assert.deepEqual([cleanup.counts.done.conversations, cleanup.counts.failed.conversations, summary.inbox.size], [3, 0, 0]);
});

test('un lot de suppressions refusé en bloc est repris conversation par conversation', async () => {
  const { run, state, fake } = await mailbox();
  fake.refused.add('b-m0');
  await run({ action: 'delete', items: inbox('a', 'b', 'c'), confirm: 3 });
  const { cleanup, summary } = await state();
  assert.deepEqual([cleanup.counts.done.conversations, cleanup.counts.failed.conversations], [2, 1]);
  assert.deepEqual([...fake.threads.keys()], ['a', 'b']);
  assert.equal(summary.inbox.size, 2000);

  // Un message déjà disparu du compte n'est pas un échec.
  fake.refused.clear();
  fake.failures.push(new NotFoundError('lot'));
  fake.threads.delete('b');
  await run({ action: 'delete', items: inbox('b'), confirm: 1 });
  const after = await state();
  assert.deepEqual([after.cleanup.counts.done.conversations, after.cleanup.counts.failed.conversations], [1, 0]);
  assert.equal(after.summary.inbox.size, 0);
});

test('le nettoyage est refusé pendant un scan, sans l’accès complet, ou mal formé', async () => {
  const { run, fake, post, cookies, scanner, store, state } = await mailbox();
  assert.equal((await run({ action: 'untrash', items: inbox('a') })).statusCode, 400);
  assert.equal((await run({ action: 'vider', items: inbox('a') })).statusCode, 400);
  assert.equal((await run({ action: 'trash', items: inbox('inconnue') })).json().error, 'selection-vide');

  fake.latencyMs = 20;
  await post('/api/gmail/scan', cookies, { scope: ALL });
  assert.equal((await run({ action: 'trash', items: inbox('a') })).json().error, 'scan-en-cours');
  await scanner.cancel(1);
  fake.latencyMs = 0;

  // Avec la seule lecture de Gmail, on peut simuler mais pas agir.
  store.saveTokens(1, { ...fake.tokens, scope: 'https://www.googleapis.com/auth/gmail.readonly' });
  assert.equal((await state()).canClean, false);
  assert.equal((await run({ action: 'trash', items: inbox('a') })).json().error, 'autorisation-incomplete');
  assert.equal((await run({ action: 'trash', items: inbox('a'), simulate: true })).statusCode, 200);
  assert.equal(fake.calls.trash, 0);
});

test('une autorisation expirée suspend le nettoyage, la reconnexion le termine', async () => {
  const context = await setup();
  const { fake, login, post, scanner, cleaner, app } = context;
  seedMailbox(fake, 40);
  const cookies = await login();
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await scanner.idle();
  const items = (await post('/api/gmail/select', cookies, { levels: [] })).json().items.map(([id]: [string]) => ({ id, zone: 'inbox' }));
  assert.ok(items.length > 30);

  fake.latencyMs = 2;
  await post('/api/gmail/cleanup', cookies, { action: 'trash', items });
  // Un scan ne peut pas démarrer pendant un nettoyage.
  assert.equal((await post('/api/gmail/scan', cookies, { scope: ALL })).json().error, 'nettoyage-en-cours');
  await new Promise((resolve) => setTimeout(resolve, 25));
  fake.failures.push(new ReauthRequiredError('expirée'));
  await cleaner.idle();
  let state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.equal(state.cleanup.status, 'auth');
  assert.ok(state.cleanup.counts.pending.conversations > 0);

  fake.latencyMs = 0;
  await login();
  await cleaner.idle();
  state = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  assert.deepEqual([state.cleanup.status, state.cleanup.counts.done.conversations, state.summary.inbox.size], ['done', items.length, 0]);
  // Ce que la base affiche correspond à ce qui a été fait sur le compte.
  const stillInInbox = [...fake.threads.values()].flatMap((thread) => thread.messages).filter((message) => message.labelIds!.includes('INBOX'));
  assert.equal(stillInInbox.length, 0);
});

test('annuler laisse de côté ce qui reste ; la sélection d’un bloc suit les filtres', async () => {
  const context = await setup();
  const { fake, login, post, scanner, cleaner, app } = context;
  seedMailbox(fake, 60);
  const cookies = await login();
  await post('/api/gmail/scan', cookies, { scope: ALL });
  await scanner.idle();

  const tree = (await post('/api/gmail/treemap', cookies, { levels: ['domain'] })).json().tree;
  const block = tree.children[0];
  const selected = (await post('/api/gmail/select', cookies, { levels: ['domain'], path: [block.k] })).json().items;
  assert.equal(selected.length, block.c);
  assert.equal(selected.reduce((sum: number, [, size]: [string, number]) => sum + size, 0), block.v);

  const all = (await post('/api/gmail/select', cookies, { levels: [] })).json().items.map(([id]: [string]) => ({ id, zone: 'inbox' }));
  fake.latencyMs = 3;
  await post('/api/gmail/cleanup', cookies, { action: 'trash', items: all });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const cancelled = (await post('/api/gmail/cleanup/cancel', cookies)).json().cleanup;
  assert.equal(cancelled.status, 'cancelled');
  assert.ok(cancelled.counts.done.conversations > 0 && cancelled.counts.skipped.conversations > 0);
  assert.equal(cancelled.counts.pending.conversations, 0);
  await cleaner.idle();
  const { summary } = (await app.inject({ url: '/api/gmail/state', cookies })).json();
  const trashed = [...fake.threads.values()].flatMap((thread) => thread.messages).filter((message) => message.labelIds!.includes('TRASH'));
  assert.equal(summary.trash.messages, trashed.length);
});

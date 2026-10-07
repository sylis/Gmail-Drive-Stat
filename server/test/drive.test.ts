import assert from 'node:assert/strict';
import { test } from 'node:test';
import { seedDrive } from '../dev/fake-google.ts';
import { fileType } from '../src/drive/store.ts';
import { ReauthRequiredError, RetryLaterError } from '../src/google.ts';
import type { TreeNode } from '../src/tree.ts';
import { setup } from './helpers.ts';

/** Somme des briques et des restes d'un arbre : doit toujours retomber sur le total de la racine. */
function leafTotal(node: TreeNode): number {
  const own = (node.bricks ?? []).reduce((sum, brick) => sum + brick.v, 0) + (node.rest?.v ?? 0);
  if (node.children) return own + node.children.reduce((sum, child) => sum + leafTotal(child), 0);
  return node.bricks ? own : node.v;
}

/** Un petit Drive connu, déjà scanné. */
async function drive() {
  const context = await setup();
  const { fake } = context;
  fake.addFolder('photos', 'Photos');
  fake.addFolder('crete', 'Crète', 'photos');
  fake.addFolder('commun', 'Projet commun', 'ailleurs', false);
  fake.addFile('a', { name: 'plage.jpg', mimeType: 'image/jpeg', size: 5000, parents: ['crete'] });
  fake.addFile('b', { name: 'film.mp4', mimeType: 'video/mp4', size: 90000, parents: ['photos'], shared: true });
  fake.addFile('c', { name: 'bail.pdf', size: 3000 });
  fake.addFile('d', { name: 'Notes', mimeType: 'application/vnd.google-apps.document', size: 0 });
  fake.addFile('e', { name: 'depot.zip', mimeType: 'application/zip', size: 7000, parents: ['commun'] });
  fake.addFile('f', { name: 'vieux.pdf', size: 2000, trashed: true });
  fake.addFile('g', { name: 'orphelin.bin', mimeType: 'application/octet-stream', size: 100, parents: undefined });
  fake.addFile('x', { name: 'a-un-autre.pdf', size: 99999, ownedByMe: false });
  const cookies = await context.login();
  const scan = async () => {
    const response = await context.post('/api/drive/scan', cookies);
    await context.driveScanner.idle();
    return response;
  };
  await scan();
  const state = async () => (await context.app.inject({ url: '/api/drive/state', cookies })).json();
  const run = async (body: object) => {
    const response = await context.post('/api/drive/cleanup', cookies, body);
    await context.driveCleaner.idle();
    return response;
  };
  return { ...context, cookies, scan, state, run };
}

const files = (...ids: string[]) => ids.map((id) => ({ id, zone: 'files' }));

test('la famille d’un fichier Drive vient de son type, Google Docs compris', () => {
  assert.equal(fileType('application/vnd.google-apps.spreadsheet', 'Budget'), 'doc');
  assert.equal(fileType('video/mp4', 'film.mp4'), 'vid');
  assert.equal(fileType('application/octet-stream', 'archive.zip'), 'zip');
});

test('le scan ne retient que vos fichiers et reconstitue leurs dossiers', async () => {
  const { state, app, cookies } = await drive();
  const { scan, summary, authorized } = await state();
  assert.equal(authorized, true);
  assert.equal(scan.status, 'done');
  // Le fichier d'un autre propriétaire n'est pas compté : le supprimer ne libérerait rien.
  assert.deepEqual(summary.files, { count: 6, size: 105100 });
  assert.deepEqual(summary.trash, { count: 1, size: 2000 });
  assert.equal(summary.folders, 2);

  const file = async (id: string) => (await app.inject({ url: `/api/drive/files/${id}`, cookies })).json();
  assert.equal((await file('a')).path, 'Mon Drive / Photos / Crète');
  assert.deepEqual((await file('a')).folder, { id: 'crete', name: 'Crète', files: 1, size: 5000 });
  assert.deepEqual((await file('b')).folder, { id: 'photos', name: 'Photos', files: 2, size: 95000 });
  assert.equal((await file('c')).path, 'Mon Drive');
  assert.equal((await file('e')).path, 'Dans des dossiers partagés / Projet commun');
  assert.equal((await file('g')).path, 'Sans dossier');
  assert.equal((await file('f')).zone, 'trash');
  assert.equal((await app.inject({ url: '/api/drive/files/x', cookies })).statusCode, 404);
});

test('le treemap par dossier retombe sur l’espace réel et se zoome', async () => {
  const { post, cookies } = await drive();
  const { tree, trash, crumbs } = (await post('/api/drive/treemap', cookies)).json();
  assert.deepEqual([tree.v, tree.c, leafTotal(tree)], [105100, 6, 105100]);
  assert.deepEqual(crumbs, []);
  assert.deepEqual([trash.v, trash.c, trash.bricks.length], [2000, 1, 1]);

  const photos = tree.children.find((node: TreeNode) => node.k === 'photos');
  assert.deepEqual([photos.n, photos.v, photos.c], ['Photos', 95000, 2]);
  // Un dossier garde ses propres fichiers à côté de ses sous-dossiers.
  assert.deepEqual(photos.bricks, [{ id: 'b', v: 90000, t: 'vid' }]);
  assert.deepEqual(photos.children.map((node: TreeNode) => [node.n, node.v]), [['Crète', 5000]]);
  // Les fichiers à la racine sont des briques de la racine ; le Google Docs, sans poids, est compté sans brique.
  assert.deepEqual(tree.bricks, [{ id: 'c', v: 3000, t: 'pdf' }]);
  assert.deepEqual(tree.rest, { c: 1, v: 0 });

  const zoomed = (await post('/api/drive/treemap', cookies, { folder: 'photos' })).json();
  assert.deepEqual([zoomed.tree.v, zoomed.tree.c], [95000, 2]);
  assert.deepEqual(zoomed.crumbs, [{ id: 'photos', name: 'Photos' }]);
  const deeper = (await post('/api/drive/treemap', cookies, { folder: 'crete' })).json();
  assert.deepEqual(deeper.crumbs.map((crumb: { name: string }) => crumb.name), ['Photos', 'Crète']);
  assert.deepEqual(deeper.tree.bricks, [{ id: 'a', v: 5000, t: 'img' }]);

  const byType = (await post('/api/drive/treemap', cookies, { group: 'type' })).json().tree;
  assert.equal(leafTotal(byType), 105100);
  assert.deepEqual(byType.children.map((node: TreeNode) => node.k).slice(0, 2), ['vid', 'zip']);

  const filtered = (await post('/api/drive/treemap', cookies, { filters: { types: ['pdf', 'img'], minSize: 2500 } })).json().tree;
  assert.deepEqual([filtered.v, filtered.c], [8000, 2]);
  const named = (await post('/api/drive/treemap', cookies, { filters: { name: 'FILM' } })).json().tree;
  assert.equal(named.v, 90000);
});

test('la liste des plus gros fichiers et la sélection suivent le dossier et les filtres', async () => {
  const { post, cookies } = await drive();
  const list = (await post('/api/drive/list', cookies)).json();
  assert.equal(list.total, 6);
  assert.deepEqual(list.rows.map((row: { name: string }) => row.name).slice(0, 3), ['film.mp4', 'depot.zip', 'plage.jpg']);
  const byName = (await post('/api/drive/list', cookies, { sort: 'name', descending: false })).json();
  assert.equal(byName.rows[0].name, 'bail.pdf');
  assert.deepEqual((await post('/api/drive/list', cookies, { zone: 'trash' })).json().rows.map((row: { id: string }) => row.id), ['f']);

  assert.deepEqual((await post('/api/drive/select', cookies, { folder: 'photos' })).json().items, [['b', 90000], ['a', 5000]]);
  assert.equal((await post('/api/drive/select', cookies, { zone: 'ailleurs' })).statusCode, 400);
});

test('un nouveau scan suit les déplacements et retire ce qui a disparu', async () => {
  const { fake, scan, state, app, cookies } = await drive();
  fake.files.delete('b');
  fake.files.get('a')!.parents = ['root'];
  fake.addFile('h', { name: 'nouveau.pdf', size: 400, parents: ['photos'] });
  fake.pageSize = 3;
  fake.driveCalls.list = 0;
  await scan();
  assert.ok(fake.driveCalls.list >= 3, 'la liste est paginée');
  assert.deepEqual((await state()).summary.files, { count: 6, size: 15500 });
  assert.equal((await app.inject({ url: '/api/drive/files/a', cookies })).json().path, 'Mon Drive');
  assert.equal((await app.inject({ url: '/api/drive/files/b', cookies })).statusCode, 404);
});

test('la corbeille Drive se restaure ; la suppression exige le bon nombre de fichiers', async () => {
  const { run, state, fake, post, cookies, driveCleaner, app } = await drive();
  const preview = (await post('/api/drive/cleanup/preview', cookies, { items: files('a', 'b', 'x', 'f') })).json();
  // Ni le fichier d'un autre, ni celui déjà à la corbeille ne font partie de la zone visée ; le fichier partagé est signalé.
  assert.deepEqual([preview.conversations, preview.size, preview.flagged], [2, 95000, 1]);

  assert.equal((await run({ action: 'trash', items: files('a', 'b') })).statusCode, 200);
  assert.deepEqual([fake.files.get('a')!.trashed, fake.files.get('b')!.trashed, fake.driveCalls.trash], [true, true, 2]);
  let { summary, cleanup } = await state();
  assert.deepEqual([summary.files.size, summary.trash.size, cleanup.restorable], [10100, 97000, true]);

  await post(`/api/drive/cleanups/${cleanup.id}/restore`, cookies);
  await driveCleaner.idle();
  assert.deepEqual([fake.files.get('a')!.trashed, fake.files.get('b')!.trashed], [false, false]);
  assert.deepEqual((await state()).summary.trash, { count: 1, size: 2000 });

  const trashed = [{ id: 'f', zone: 'trash' }];
  assert.equal((await run({ action: 'delete', items: trashed })).json().error, 'confirmation-requise');
  assert.equal(fake.files.has('f'), true);
  assert.equal((await run({ action: 'delete', items: trashed, confirm: 1 })).statusCode, 200);
  assert.equal(fake.files.has('f'), false);
  ({ summary, cleanup } = await state());
  assert.deepEqual([summary.trash.count, cleanup.restorable], [0, false]);
  const journal = (await app.inject({ url: '/api/drive/cleanups', cookies })).json().cleanups;
  assert.deepEqual(journal.map((entry: { action: string }) => entry.action), ['delete', 'untrash', 'trash']);
  const items = (await app.inject({ url: `/api/drive/cleanups/${cleanup.id}/items`, cookies })).json().items;
  assert.deepEqual(items.map((item: { subject: string; domain: string; state: string }) => [item.subject, item.domain, item.state]), [
    ['vieux.pdf', 'Mon Drive', 'done'],
  ]);
});

test('simulation, refus de Drive et garde-fous', async () => {
  const { run, state, fake, post, cookies, driveCleaner, store, driveScanner } = await drive();
  await run({ action: 'delete', items: files('a', 'b', 'c'), confirm: 3, simulate: true });
  assert.deepEqual([fake.driveCalls.delete, fake.files.size], [0, 11]);
  assert.deepEqual([(await state()).cleanup.simulate, (await state()).summary.files.count], [true, 6]);

  fake.refused.add('b');
  await run({ action: 'trash', items: files('a', 'b', 'c') });
  let { cleanup, summary } = await state();
  assert.deepEqual([cleanup.counts.done.conversations, cleanup.counts.failed.conversations, summary.files.size], [2, 1, 97100]);
  fake.refused.clear();
  await post(`/api/drive/cleanups/${cleanup.id}/retry`, cookies);
  await driveCleaner.idle();
  ({ cleanup, summary } = await state());
  assert.deepEqual([cleanup.counts.done.conversations, cleanup.counts.failed.conversations, summary.files.size], [3, 0, 7100]);

  // Un fichier déjà disparu du compte n'est pas un échec.
  fake.files.delete('e');
  await run({ action: 'trash', items: files('e') });
  assert.deepEqual([(await state()).cleanup.counts.done.conversations, (await state()).summary.files.size], [1, 100]);

  assert.equal((await run({ action: 'untrash', items: files('g') })).statusCode, 400);
  fake.latencyMs = 20;
  await post('/api/drive/scan', cookies);
  assert.equal((await run({ action: 'trash', items: files('g') })).json().error, 'scan-en-cours');
  await driveScanner.cancel(1);
  fake.latencyMs = 0;

  // Avec la seule lecture des métadonnées, on peut simuler mais pas agir.
  store.saveTokens(1, { ...fake.tokens, scope: 'https://www.googleapis.com/auth/drive.metadata.readonly' });
  assert.deepEqual([(await state()).authorized, (await state()).canClean], [true, false]);
  assert.equal((await run({ action: 'trash', items: files('g') })).json().error, 'autorisation-incomplete');
  assert.equal((await run({ action: 'trash', items: files('g'), simulate: true })).statusCode, 200);
});

test('un gros Drive : totaux exacts, limites de Google et reconnexion', async () => {
  const { fake, login, post, driveScanner, app } = await setup();
  seedDrive(fake, 600);
  const cookies = await login();
  fake.failures.push(new RetryLaterError('429'));
  fake.latencyMs = 2;
  await post('/api/drive/scan', cookies);
  assert.equal((await post('/api/drive/scan', cookies)).statusCode, 409);
  await new Promise((resolve) => setTimeout(resolve, 12));
  fake.failures.push(new ReauthRequiredError('expirée'));
  await driveScanner.idle();
  let state = (await app.inject({ url: '/api/drive/state', cookies })).json();
  assert.equal(state.scan.status, 'auth');

  fake.latencyMs = 0;
  await login();
  await driveScanner.idle();
  state = (await app.inject({ url: '/api/drive/state', cookies })).json();
  assert.equal(state.scan.status, 'done');
  const owned = [...fake.files.values()].filter((file) => file.mimeType !== 'application/vnd.google-apps.folder');
  const size = (list: typeof owned) => list.reduce((sum, file) => sum + Number(file.quotaBytesUsed), 0);
  assert.deepEqual(state.summary.files, { count: owned.filter((file) => !file.trashed).length, size: size(owned.filter((file) => !file.trashed)) });
  assert.equal(state.summary.trash.size, size(owned.filter((file) => file.trashed)));

  const { tree } = (await post('/api/drive/treemap', cookies)).json();
  assert.equal(leafTotal(tree), state.summary.files.size);
  assert.ok(tree.children.some((node: TreeNode) => node.n === 'Dans des dossiers partagés'));
});

test('les données Drive exigent une session et disparaissent avec le compte', async () => {
  const { app, db, post, cookies, state } = await drive();
  assert.equal((await app.inject({ url: '/api/drive/state' })).statusCode, 401);
  assert.equal((await post('/api/drive/treemap', {})).statusCode, 401);
  await post('/api/drive/erase', cookies);
  assert.deepEqual([(await state()).summary.files.count, (await state()).scan], [0, null]);
  await post('/api/drive/scan', cookies);
  await post('/api/account/revoke', cookies);
  for (const table of ['drive_files', 'drive_scans', 'drive_cleanups', 'drive_cleanup_items']) {
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 0, table);
  }
});

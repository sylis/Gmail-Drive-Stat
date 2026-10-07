<script lang="ts">
  import ActionBar from '../cleanup/ActionBar.svelte';
  import CleanupPanel from '../cleanup/CleanupPanel.svelte';
  import ConfirmDialog from '../cleanup/ConfirmDialog.svelte';
  import JournalDialog from '../cleanup/JournalDialog.svelte';
  import { ApiError, type Quota } from '../lib/api';
  import type { CleanupItem } from '../lib/cleanup';
  import {
    driveCleanup,
    FILE_TYPES,
    getDriveFile,
    getDriveList,
    getDriveTreemap,
    selectDriveFiles,
    type DriveFile,
    type DriveFilters,
    type DriveListRow,
    type DriveState,
    type DriveTreemap,
    type DriveZone,
  } from '../lib/drive';
  import { formatBytes } from '../lib/format';
  import Treemap from '../Treemap.svelte';

  let {
    quota,
    state: drive,
    refreshKey,
    scanning,
    onrescan,
    onchange,
    onauth,
  }: {
    quota: Quota | null;
    state: DriveState;
    /** Change quand la base a été modifiée (scan terminé, nettoyage qui avance) : les vues se rechargent. */
    refreshKey: number;
    scanning: boolean;
    onrescan: () => void;
    /** Une action a modifié l'état du serveur : à relire sans attendre. */
    onchange: () => void;
    onauth: () => void;
  } = $props();

  const COLORS = Object.fromEntries(Object.entries(FILE_TYPES).map(([key, type]) => [key, type.color]));
  const MB = 1024 * 1024;
  const ZONES: Record<DriveZone, string> = { files: 'Mes fichiers', trash: 'Corbeille' };
  const COLUMNS: { key: string; label: string; num?: boolean }[] = [
    { key: 'name', label: 'Fichier' },
    { key: 'path', label: 'Dossier' },
    { key: 'modified', label: 'Modifié', num: true },
    { key: 'size', label: 'Taille', num: true },
  ];

  let folder = $state<string | null>(null);
  let filters = $state<DriveFilters>({});
  let group = $state<'folder' | 'type'>('folder');
  let mode = $state<'treemap' | 'list'>('treemap');
  let data = $state<DriveTreemap | null>(null);
  /** Dossier pour lequel `data` a été calculé : la vue affichée peut avoir un temps de retard sur la vue demandée. */
  let shownFolder = $state<string | null>(null);
  let loadError = $state(false);
  let filtersOpen = $state(true);
  let trashFolded = $state(false);
  let nameSearch = $state('');

  let listZone = $state<DriveZone>('files');
  let sort = $state('size');
  let descending = $state(true);
  let rows = $state<DriveListRow[]>([]);
  let listTotal = $state(0);

  interface Picked {
    id: string;
    zone: DriveZone;
    size: number;
  }
  /** Fichier affiché dans le panneau de détail. */
  let focus = $state<{ id: string; zone: DriveZone } | null>(null);
  /** Panier : les fichiers sur lesquels portent les actions, par clé « zone:fichier ». */
  let picked = $state(new Map<string, Picked>());
  let file = $state<DriveFile | null>(null);
  let simulate = $state(false);
  let confirming = $state<'trash' | 'delete' | null>(null);
  let showJournal = $state(false);
  let closedCleanup = $state<number | null>(null);
  let failures = $state<CleanupItem[]>([]);
  let actionError = $state<string | null>(null);

  const view = $derived({ folder, filters });
  const keys = $derived(new Set(picked.keys()));
  const selectedIn = $derived.by(() => {
    const sets: Record<DriveZone, Set<string>> = { files: new Set(), trash: new Set() };
    for (const item of picked.values()) sets[item.zone].add(item.id);
    return sets;
  });
  const pickedSize = $derived([...picked.values()].reduce((sum, item) => sum + item.size, 0));
  const targets = $derived([...picked.values()].map(({ id, zone }) => ({ id, zone })));
  const cleaning = $derived(drive.cleanup !== null && ['running', 'auth'].includes(drive.cleanup.status));
  const failedIds = $derived(new Set(failures.filter((item) => item.zone === 'files').map((item) => item.id)));
  const driveQuota = $derived(quota?.parts.find((part) => part.key === 'drive')?.bytes ?? null);
  const filtered = $derived(Boolean(filters.types || filters.minSize || filters.modifiedFrom || filters.modifiedTo || filters.name));
  const maxRow = $derived(Math.max(1, ...rows.map((row) => row.size)));

  $effect(() => {
    void refreshKey;
    const current = view;
    const grouping = group;
    let stale = false;
    getDriveTreemap(current, grouping).then(
      (result) => {
        if (stale) return;
        data = result;
        shownFolder = current.folder;
        loadError = false;
      },
      (cause) => {
        if (cause instanceof ApiError && cause.status === 401) onauth();
        else if (!stale) loadError = true;
      },
    );
    return () => (stale = true);
  });

  $effect(() => {
    void refreshKey;
    if (mode !== 'list') return;
    const query = { ...view, zone: listZone, sort, descending, offset: 0 };
    let stale = false;
    getDriveList(query).then(
      (page) => {
        if (stale) return;
        rows = page.rows;
        listTotal = page.total;
      },
      () => undefined,
    );
    return () => (stale = true);
  });

  $effect(() => {
    void refreshKey;
    const current = focus;
    if (!current) {
      file = null;
      return;
    }
    let stale = false;
    getDriveFile(current.id).then(
      (result) => !stale && (file = result),
      () => !stale && (file = null),
    );
    return () => (stale = true);
  });

  // Les échecs du dernier nettoyage : encadrés de rouge dans le treemap, listés dans le bandeau.
  $effect(() => {
    const cleanup = drive.cleanup;
    if (!cleanup || cleanup.counts.failed.conversations === 0) {
      failures = [];
      return;
    }
    let stale = false;
    driveCleanup.items(cleanup.id, 'failed').then(
      (result) => !stale && (failures = result.items),
      () => undefined,
    );
    return () => (stale = true);
  });

  // La recherche par nom attend la fin de la frappe.
  $effect(() => {
    const term = nameSearch.trim();
    const timer = setTimeout(() => {
      if ((filters.name ?? '') !== term) filters = { ...filters, name: term || undefined };
    }, 300);
    return () => clearTimeout(timer);
  });

  /** Clic : le fichier remplace la sélection. Ctrl+clic : il s'y ajoute ou en sort. */
  function pick(item: Picked, additive: boolean) {
    const key = `${item.zone}:${item.id}`;
    if (additive) {
      const next = new Map(picked);
      if (!next.delete(key)) next.set(key, item);
      picked = next;
    } else picked = new Map([[key, item]]);
    focus = { id: item.id, zone: item.zone };
  }

  /** Ajoute au panier tous les fichiers d'un dossier (sous-dossiers compris), ou tout ce qui est filtré. */
  async function addAll(target: string | null, zone: DriveZone, replace: boolean) {
    actionError = null;
    try {
      const { items } = await selectDriveFiles({ folder: target, filters }, zone);
      const next = new Map(replace ? [] : picked);
      for (const [id, size] of items) next.set(`${zone}:${id}`, { id, zone, size });
      picked = next;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onauth();
      actionError = 'La sélection n’a pas pu être calculée. Réessayez dans un instant.';
    }
  }

  function toggleType(type: string) {
    const current = filters.types ?? [];
    const next = current.includes(type) ? current.filter((other) => other !== type) : [...current, type];
    filters = { ...filters, types: next.length > 0 ? next : undefined };
  }

  function sortBy(key: string) {
    if (key === sort) descending = !descending;
    else {
      sort = key;
      descending = key === 'size' || key === 'modified';
    }
  }

  async function more() {
    const page = await getDriveList({ ...view, zone: listZone, sort, descending, offset: rows.length });
    rows = [...rows, ...page.rows];
  }

  function started() {
    confirming = null;
    closedCleanup = null;
    picked = new Map();
    onchange();
  }
</script>

<div class="explorer">
  <div class="scopebar">
    <span class="lbl">Périmètre</span>
    <span class="chip">vos fichiers</span>
    <span class="muted">
      · {drive.summary.files.count.toLocaleString('fr-FR')} fichiers dans {drive.summary.folders.toLocaleString('fr-FR')} dossiers ·
      {formatBytes(drive.summary.files.size)}{#if driveQuota !== null}
        &nbsp;sur {formatBytes(driveQuota)} de Drive selon Google{/if}
    </span>
    <span class="grow"></span>
    {#if drive.summary.lastScannedAt}
      <span class="muted">Dernière lecture le {new Date(drive.summary.lastScannedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
    {/if}
    <button class="btn small" onclick={onrescan} disabled={scanning || cleaning}>↻ Actualiser</button>
  </div>

  {#if drive.cleanup && drive.cleanup.id !== closedCleanup}
    <CleanupPanel service={driveCleanup} cleanup={drive.cleanup} {failures} {onchange} onclose={() => (closedCleanup = drive.cleanup?.id ?? null)} />
  {/if}
  {#if actionError}<div class="callout warn" role="alert">{actionError}</div>{/if}

  <div class="main" class:nofilters={!filtersOpen}>
    {#if filtersOpen}
      <aside class="filters">
        <div class="row">
          <span class="lbl grow">Filtres</span>
          {#if filtered}
            <button
              class="link"
              onclick={() => {
                filters = {};
                nameSearch = '';
              }}>Tout effacer</button
            >
          {/if}
        </div>
        <label class="axis">
          <span class="head">Nom du fichier</span>
          <input class="input" type="search" placeholder="Rechercher…" bind:value={nameSearch} />
        </label>
        <div class="axis">
          <span class="head">Type de fichier</span>
          {#each Object.entries(FILE_TYPES) as [key, type] (key)}
            <label class="row"
              ><input type="checkbox" checked={filters.types?.includes(key) ?? false} onchange={() => toggleType(key)} />
              <i class="sw" style:background="var({type.color})"></i>{type.label}</label
            >
          {/each}
        </div>
        <div class="axis">
          <span class="head">Dernière modification</span>
          <div class="row dates">
            <input
              class="input"
              type="date"
              aria-label="Modifié à partir du"
              value={filters.modifiedFrom ?? ''}
              onchange={(event) => (filters = { ...filters, modifiedFrom: event.currentTarget.value || undefined })}
            />
            <span aria-hidden="true">→</span>
            <input
              class="input"
              type="date"
              aria-label="Modifié jusqu’au"
              value={filters.modifiedTo ?? ''}
              onchange={(event) => (filters = { ...filters, modifiedTo: event.currentTarget.value || undefined })}
            />
          </div>
          <span class="hint">Une date de fin ancienne isole les fichiers oubliés.</span>
        </div>
        <label class="axis last">
          <span class="head">Taille minimale</span>
          <select
            class="input"
            value={filters.minSize ?? 0}
            onchange={(event) => (filters = { ...filters, minSize: Number(event.currentTarget.value) || undefined })}
          >
            <option value={0}>Aucune</option>
            {#each [1, 10, 50, 100, 500, 1024] as size (size)}<option value={size * MB}>{formatBytes(size * MB)}</option>{/each}
          </select>
        </label>
      </aside>
    {/if}

    <div class="center">
      <div class="row wrap">
        <button class="btn small ghost" onclick={() => (filtersOpen = !filtersOpen)} aria-expanded={filtersOpen}>
          {filtersOpen ? '‹ Masquer les filtres' : 'Filtres ›'}
        </button>
        <span class="lbl">Regrouper</span>
        <div class="seg" role="group" aria-label="Regroupement">
          <button class:on={group === 'folder'} aria-pressed={group === 'folder'} onclick={() => (group = 'folder')}>Par dossier</button>
          <button class:on={group === 'type'} aria-pressed={group === 'type'} onclick={() => (group = 'type')}>Par type</button>
        </div>
        <span class="grow"></span>
        <div class="seg" role="group" aria-label="Affichage">
          <button class:on={mode === 'treemap'} aria-pressed={mode === 'treemap'} onclick={() => (mode = 'treemap')}>Treemap</button>
          <button class:on={mode === 'list'} aria-pressed={mode === 'list'} onclick={() => (mode = 'list')}>Plus gros fichiers</button>
        </div>
      </div>

      <div class="row wrap crumbs">
        <nav aria-label="Fil d'Ariane">
          <button disabled={folder === null} onclick={() => (folder = null)}>Mon Drive</button>
          {#each data?.crumbs ?? [] as crumb, index (crumb.id)}
            › <button disabled={index === (data?.crumbs.length ?? 0) - 1} onclick={() => (folder = crumb.id)}>{crumb.name}</button>
          {/each}
        </nav>
        {#if data}<span class="muted">· {data.tree.c.toLocaleString('fr-FR')} fichiers · {formatBytes(data.tree.v)}</span>{/if}
        {#if folder}<button class="chip" onclick={() => addAll(folder, 'files', false)}>Sélectionner tout ce dossier</button>{/if}
      </div>

      {#if loadError}<div class="callout warn" role="alert">La lecture des résultats a échoué. Rechargez la page.</div>{/if}

      <div class="stage">
        <div class="view">
          {#if mode === 'treemap'}
            {#if data && data.tree.v > 0}
              <Treemap
                tree={data.tree}
                nameOf={(_depth, key) => FILE_TYPES[key]?.label ?? key}
                colors={COLORS}
                selected={selectedIn.files}
                failed={failedIds}
                unit="fichiers"
                label="Treemap du Drive : une brique par fichier"
                onbrick={(brick, _block, additive) => pick({ id: brick.id, zone: 'files', size: brick.v }, additive)}
                onzoom={(relative) => {
                  if (group === 'folder') folder = relative.at(-1) ?? shownFolder;
                  else toggleType(relative[0]!);
                }}
              />
            {:else if data}
              <p class="empty muted">
                {data.tree.c > 0 ? 'Les fichiers retenus ne pèsent rien dans votre quota (documents Google).' : 'Aucun fichier ne correspond.'}
              </p>
            {/if}
          {:else}
            <div class="listwrap">
              <div class="row">
                <div class="seg" role="group" aria-label="Zone">
                  {#each Object.entries(ZONES) as [key, label] (key)}
                    <button class:on={listZone === key} aria-pressed={listZone === key} onclick={() => (listZone = key as DriveZone)}>{label}</button>
                  {/each}
                </div>
                <span class="grow"></span>
                <span class="muted">{listTotal.toLocaleString('fr-FR')} fichiers</span>
              </div>
              <div class="table-wrap">
                <table>
                  <thead>
                    <tr>
                      {#each COLUMNS as column (column.key)}
                        <th class:num={column.num} class:on={sort === column.key} aria-sort={sort === column.key ? (descending ? 'descending' : 'ascending') : 'none'}>
                          <button onclick={() => sortBy(column.key)}>{column.label}{sort === column.key ? (descending ? ' ▼' : ' ▲') : ''}</button>
                        </th>
                      {/each}
                    </tr>
                  </thead>
                  <tbody>
                    {#each rows as row (row.id)}
                      <tr
                        class="clickable"
                        class:sel={keys.has(`${row.zone}:${row.id}`)}
                        onclick={(event) => pick({ id: row.id, zone: row.zone, size: row.size }, event.ctrlKey || event.metaKey)}
                      >
                        <td><i class="sw" style:background="var({FILE_TYPES[row.type]?.color ?? '--t-oth'})"></i> {row.name}</td>
                        <td>{row.path}</td>
                        <td class="num">{new Date(row.modified).toLocaleDateString('fr-FR')}</td>
                        <td class="num"><span class="szbar" style:width="{Math.round((row.size / maxRow) * 40)}px"></span>{formatBytes(row.size)}</td>
                      </tr>
                    {:else}
                      <tr><td colspan="4" class="muted">Aucun fichier ne correspond.</td></tr>
                    {/each}
                  </tbody>
                </table>
                {#if rows.length < listTotal}
                  <button class="btn small more" onclick={more}>
                    Afficher la suite ({rows.length.toLocaleString('fr-FR')} sur {listTotal.toLocaleString('fr-FR')})
                  </button>
                {/if}
              </div>
            </div>
          {/if}
        </div>

        {#if mode === 'treemap' && data}
          <div class="zone" class:closed={trashFolded}>
            <div class="zone-head">
              <div class="row">
                {#if !trashFolded}<b>Corbeille</b>{/if}
                <button
                  class="fold"
                  aria-expanded={!trashFolded}
                  aria-label="{trashFolded ? 'Déplier' : 'Replier'} la zone Corbeille"
                  onclick={() => (trashFolded = !trashFolded)}>{trashFolded ? '‹' : '›'}</button
                >
              </div>
              {#if trashFolded}
                <span class="vertical">Corbeille · {formatBytes(data.trash.v)}</span>
              {:else}
                <span class="muted mono">{formatBytes(data.trash.v)}</span>
                <span class="muted">vidée sous 30 j</span>
                {#if data.trash.c > 0}
                  <button class="link" onclick={() => addAll(null, 'trash', false)}>Tout sélectionner</button>
                {/if}
              {/if}
            </div>
            {#if !trashFolded && data.trash.bricks.length > 0}
              <div class="zone-body">
                <Treemap
                  tree={{ k: null, v: data.trash.v, c: data.trash.c, bricks: data.trash.bricks }}
                  colors={COLORS}
                  selected={selectedIn.trash}
                  hatched
                  unit="fichiers"
                  label="Corbeille Drive"
                  onbrick={(brick, _block, additive) => pick({ id: brick.id, zone: 'trash', size: brick.v }, additive)}
                />
              </div>
            {/if}
          </div>
        {/if}
      </div>

      <div class="legend">
        {#each Object.entries(FILE_TYPES) as [key, type] (key)}
          <button class:on={filters.types?.includes(key)} onclick={() => toggleType(key)} title="Filtrer sur ce type">
            <i class="sw" style:background="var({type.color})"></i>{type.label}
          </button>
        {/each}
        <span class="grow"></span>
        <span class="hint">Ctrl+clic pour ajouter un fichier à la sélection.</span>
      </div>
    </div>

    <aside class="detail">
      <span class="lbl">Fichier</span>
      {#if file}
        <h3>{file.name}</h3>
        <dl>
          <dt>Zone</dt><dd>{ZONES[file.zone]}</dd>
          <dt>Dossier</dt><dd>{file.path}</dd>
          <dt>Type</dt><dd><i class="sw" style:background="var({FILE_TYPES[file.type]?.color ?? '--t-oth'})"></i> {FILE_TYPES[file.type]?.label ?? 'Autre'}</dd>
          <dt>Modifié le</dt><dd class="mono">{new Date(file.modified).toLocaleDateString('fr-FR')}</dd>
          <dt>Taille</dt><dd class="mono"><b>{formatBytes(file.size)}</b></dd>
        </dl>
        {#if file.shared}
          <div class="callout">Partagé avec d'autres personnes : le supprimer le leur retire aussi.</div>
        {/if}
        {#if file.starred}<span class="hint">Marqué comme suivi dans Drive.</span>{/if}
        {#if file.link}
          <a class="btn small ghost" href={file.link} target="_blank" rel="noopener noreferrer">Ouvrir dans Drive ↗</a>
        {/if}
        {#if file.folder}
          {@const parent = file.folder}
          <div class="block col">
            <span class="lbl">Dossier parent</span>
            <b>{parent.name}</b>
            <span class="muted mono">{parent.files.toLocaleString('fr-FR')} fichiers · {formatBytes(parent.size)}</span>
            <button class="btn small" onclick={() => (folder = parent.id)}>Zoomer sur le dossier</button>
            <button class="btn small" onclick={() => addAll(parent.id, 'files', false)}>Sélectionner tout le dossier</button>
            <span class="hint">Sous-dossiers compris, selon les filtres en cours.</span>
          </div>
        {/if}
      {:else}
        <p class="hint">Cliquez sur une brique du treemap ou une ligne de la liste pour voir le fichier.</p>
      {/if}
    </aside>
  </div>
</div>

<ActionBar
  summary={driveCleanup.count(picked.size)}
  size={pickedSize}
  empty={picked.size === 0}
  total={data?.tree.c ?? 0}
  bind:simulate
  blocked={scanning ? 'Nettoyage indisponible pendant un scan.' : cleaning ? 'Un nettoyage est en cours.' : null}
  needsAccess={!drive.canClean}
  serviceName="Drive"
  onselectall={() => addAll(folder, 'files', true)}
  onclear={() => (picked = new Map())}
  onaction={(action) => (confirming = action)}
  onjournal={() => (showJournal = true)}
/>

{#if confirming}
  <ConfirmDialog service={driveCleanup} action={confirming} items={targets} {simulate} ondone={started} oncancel={() => (confirming = null)} />
{/if}
{#if showJournal}<JournalDialog service={driveCleanup} onclose={() => (showJournal = false)} />{/if}

<style>
  .filters,
  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    min-width: 0;
  }

  .axis {
    border-bottom: 1px solid var(--fill2);
    padding-bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: 13px;
  }

  .axis.last {
    border-bottom: 0;
  }

  .axis label {
    cursor: pointer;
  }

  .head {
    font-weight: 600;
  }

  .dates {
    gap: 4px;
  }

  .dates .input {
    flex: 1;
    padding: 4px;
    font-size: 12px;
  }

  .hint {
    font-size: 12px;
  }

  .link {
    font: inherit;
    font-size: 12px;
    color: var(--accent);
    background: none;
    border: 0;
    padding: 0;
    cursor: pointer;
    text-align: left;
  }

  .listwrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
  }

  .listwrap .table-wrap {
    flex: 1;
    min-height: 0;
  }

  .szbar {
    display: inline-block;
    height: 6px;
    border-radius: 3px;
    background: var(--fill2);
    vertical-align: middle;
    margin-right: 6px;
  }

  .more {
    margin: 8px;
  }

  h3 {
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 4px 8px;
    margin: 0;
    font-size: 13px;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .detail .callout {
    font-size: 13px;
  }

  .detail .btn {
    align-self: flex-start;
  }

  .block {
    margin-top: auto;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
    font-size: 13px;
  }
</style>

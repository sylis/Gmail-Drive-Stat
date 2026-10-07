<script lang="ts">
  import { ApiError, type Quota } from '../lib/api';
  import { formatBytes } from '../lib/format';
  import {
    ATT_TYPES,
    AXIS_LABELS,
    axisValueLabel,
    describeScope,
    getConversation,
    getTreemap,
    gmailCleanup,
    selectAll,
    ZONE_LABELS,
    type Axis,
    type Conversation,
    type Filters,
    type GmailState,
    type TreemapData,
    type Zone,
  } from '../lib/gmail';
  import ActionBar from '../cleanup/ActionBar.svelte';
  import CleanupPanel from '../cleanup/CleanupPanel.svelte';
  import ConfirmDialog from '../cleanup/ConfirmDialog.svelte';
  import JournalDialog from '../cleanup/JournalDialog.svelte';
  import type { CleanupItem } from '../lib/cleanup';
  import Treemap, { type Block } from '../Treemap.svelte';
  import AttachmentList from './AttachmentList.svelte';
  import ConversationList from './ConversationList.svelte';
  import DetailPanel from './DetailPanel.svelte';
  import FiltersPanel from './FiltersPanel.svelte';

  let {
    email,
    quota,
    state: gmail,
    refreshKey,
    onrescan,
    onshowscan,
    onchange,
    onauth,
  }: {
    email: string;
    quota: Quota | null;
    state: GmailState;
    /** Change quand la base a été modifiée (scan qui avance) : les vues se rechargent. */
    refreshKey: number;
    onrescan: () => void;
    onshowscan: () => void;
    /** Une action a modifié l'état du serveur : à relire sans attendre. */
    onchange: () => void;
    onauth: () => void;
  } = $props();

  const PRESETS: { name: string; levels: Axis[] }[] = [
    { name: 'Par période', levels: ['year', 'quarter', 'domain'] },
    { name: 'Par expéditeur', levels: ['domain', 'sender'] },
    { name: 'Par libellé', levels: ['label', 'year'] },
    { name: 'Par type de pièce jointe', levels: ['attType', 'domain'] },
    { name: 'Par liste de diffusion', levels: ['list', 'year'] },
    { name: 'Par catégorie Gmail', levels: ['category', 'domain'] },
    { name: 'Sans regroupement', levels: [] },
  ];
  const COLORS = Object.fromEntries(Object.entries(ATT_TYPES).map(([key, type]) => [key, type.color]));
  const MAX_LEVELS = 5;

  let levels = $state<Axis[]>(PRESETS[0]!.levels);
  let path = $state<string[]>([]);
  let filters = $state<Filters>({});
  let mode = $state<'treemap' | 'list' | 'attachments'>('treemap');
  let data = $state<TreemapData | null>(null);
  /** Niveaux et zoom pour lesquels `data` a été calculé : la vue affichée peut avoir un temps de retard sur la vue demandée. */
  let shown = $state<{ levels: Axis[]; path: string[] }>({ levels: [], path: [] });
  let loadError = $state(false);
  let filtersOpen = $state(true);
  let folded = $state<Record<'sent' | 'trash', boolean>>({ sent: false, trash: false });
  let dragged = $state<number | null>(null);

  interface Picked {
    id: string;
    zone: Zone;
    size: number;
  }
  /** Brique dont le panneau de détail montre la conversation. */
  let focus = $state<{ id: string; zone: Zone; block: Block | null } | null>(null);
  /** Panier : les briques sur lesquelles portent les actions, par clé « zone:conversation ». */
  let picked = $state(new Map<string, Picked>());
  let conversation = $state<Conversation | null>(null);
  let simulate = $state(false);
  let confirming = $state<'trash' | 'delete' | null>(null);
  let showJournal = $state(false);
  let closedCleanup = $state<number | null>(null);
  let failures = $state<CleanupItem[]>([]);
  let actionError = $state<string | null>(null);

  const view = $derived({ levels, path, filters });
  const keys = $derived(new Set(picked.keys()));
  const selectedIn = $derived.by(() => {
    const sets: Record<Zone, Set<string>> = { inbox: new Set(), sent: new Set(), trash: new Set() };
    for (const item of picked.values()) sets[item.zone].add(item.id);
    return sets;
  });
  const pickedSize = $derived([...picked.values()].reduce((sum, item) => sum + item.size, 0));
  const targets = $derived([...picked.values()].map(({ id, zone }) => ({ id, zone })));
  const cleaning = $derived(gmail.cleanup !== null && ['running', 'auth'].includes(gmail.cleanup.status));
  const failedIds = $derived(new Set(failures.filter((item) => item.zone === 'inbox').map((item) => item.id)));
  const preset = $derived(PRESETS.findIndex((candidate) => candidate.levels.join() === levels.join()));
  const unused = $derived((Object.keys(AXIS_LABELS) as Axis[]).filter((axis) => !levels.includes(axis)));
  const scope = $derived(gmail.scan?.scope ?? gmail.scopes[0]?.scope);
  const scanning = $derived(gmail.scan !== null && ['running', 'paused', 'auth'].includes(gmail.scan.status));
  const scanned = $derived(gmail.summary.inbox.size + gmail.summary.sent.size + gmail.summary.trash.size);
  const gmailPhotos = $derived(quota?.parts.find((part) => part.key === 'gmailPhotos')?.bytes ?? null);

  const chips = $derived.by(() => {
    const list: { text: string; remove: () => void }[] = [];
    const day = (value: string) => new Date(value).toLocaleDateString('fr-FR');
    if (filters.dateFrom || filters.dateTo) {
      list.push({
        text: `Période ${filters.dateFrom ? day(filters.dateFrom) : '…'} → ${filters.dateTo ? day(filters.dateTo) : '…'}`,
        remove: () => (filters = { ...filters, dateFrom: undefined, dateTo: undefined }),
      });
    }
    if (filters.minSize) list.push({ text: `≥ ${formatBytes(filters.minSize)}`, remove: () => (filters = { ...filters, minSize: undefined }) });
    for (const [axis, entry] of Object.entries(filters.axes ?? {}) as [Axis, { values: string[]; exclude?: boolean }][]) {
      const names = entry.values.slice(0, 2).map((value) => axisValueLabel(axis, value));
      const more = entry.values.length > 2 ? ` +${entry.values.length - 2}` : '';
      list.push({
        text: `${AXIS_LABELS[axis]} ${entry.exclude ? '≠' : ':'} ${names.join(', ')}${more}`,
        remove: () => {
          const axes = { ...filters.axes };
          delete axes[axis];
          filters = { ...filters, axes };
        },
      });
    }
    return list;
  });

  $effect(() => {
    void refreshKey;
    const current = view;
    let stale = false;
    getTreemap(current).then(
      (result) => {
        if (stale) return;
        data = result;
        shown = { levels: current.levels, path: current.path };
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
    const current = focus;
    if (!current) {
      conversation = null;
      return;
    }
    let stale = false;
    getConversation(current.id, current.zone).then(
      (result) => !stale && (conversation = result),
      () => !stale && (conversation = null),
    );
    return () => (stale = true);
  });

  const blockName = (blockPath: string[]) => blockPath.map((key, depth) => axisValueLabel(levels[depth]!, key)).join(' · ');

  function setLevels(next: Axis[]) {
    levels = next;
    path = [];
    // Le bloc parent de la brique affichée n'a plus de sens avec d'autres niveaux.
    if (focus) focus = { ...focus, block: null };
  }

  function drop(target: number) {
    if (dragged === null || dragged === target) return;
    const next = [...levels];
    next.splice(target, 0, ...next.splice(dragged, 1));
    dragged = null;
    setLevels(next);
  }

  // Les échecs du dernier nettoyage : encadrés de rouge dans le treemap, listés dans le bandeau.
  $effect(() => {
    const cleanup = gmail.cleanup;
    if (!cleanup || cleanup.counts.failed.conversations === 0) {
      failures = [];
      return;
    }
    let stale = false;
    gmailCleanup.items(cleanup.id, 'failed').then(
      (result) => !stale && (failures = result.items),
      () => undefined,
    );
    return () => (stale = true);
  });

  /** Clic : la brique remplace la sélection. Ctrl+clic : elle s'y ajoute ou en sort. */
  function pick(item: Picked, block: Block | null, additive: boolean) {
    const key = `${item.zone}:${item.id}`;
    if (additive) {
      const next = new Map(picked);
      if (!next.delete(key)) next.set(key, item);
      picked = next;
    } else picked = new Map([[key, item]]);
    focus = { id: item.id, zone: item.zone, block };
  }

  /** Ajoute au panier toutes les conversations reçues d'une vue : un bloc, ou tout ce qui est filtré. */
  async function addAll(blockPath: string[], replace: boolean) {
    actionError = null;
    try {
      const { items } = await selectAll({ levels, path: blockPath, filters }, 'inbox');
      const next = new Map(replace ? [] : picked);
      for (const [id, size] of items) next.set(`inbox:${id}`, { id, zone: 'inbox', size });
      picked = next;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onauth();
      actionError = 'La sélection n’a pas pu être calculée. Réessayez dans un instant.';
    }
  }

  /** Étend la sélection aux messages envoyés de la conversation affichée. */
  function addWholeConversation() {
    if (!conversation) return;
    const next = new Map(picked);
    next.set(`${conversation.zone}:${conversation.id}`, { id: conversation.id, zone: conversation.zone, size: conversation.size });
    for (const other of conversation.otherZones) {
      if (other.zone !== 'trash') next.set(`${other.zone}:${conversation.id}`, { id: conversation.id, zone: other.zone, size: other.size });
    }
    picked = next;
  }

  /** Archiver, lu, non lu : sans confirmation, comme le prévoit la maquette ; rien n'est supprimé. */
  async function sort(action: 'archive' | 'read' | 'unread') {
    actionError = null;
    try {
      await gmailCleanup.start({ action, items: targets, simulate });
      started();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onauth();
      actionError = 'L’action n’a pas pu démarrer. Réessayez dans un instant.';
    }
  }

  function started() {
    confirming = null;
    closedCleanup = null;
    picked = new Map();
    onchange();
  }

  function toggleType(type: string) {
    const current = filters.axes?.attType?.values ?? [];
    const values = current.includes(type) ? current.filter((other) => other !== type) : [...current, type];
    const axes = { ...filters.axes };
    if (values.length > 0) axes.attType = { values };
    else delete axes.attType;
    filters = { ...filters, axes };
  }
</script>

<div class="explorer">
<div class="scopebar">
  <span class="lbl">Périmètre</span>
  {#if scope}
    {#each describeScope(scope, gmail.labels) as part (part)}<span class="chip">{part}</span>{/each}
  {/if}
  <span class="muted">
    · {gmail.summary.conversations.toLocaleString('fr-FR')} conversations · {formatBytes(scanned)} scannés{#if gmailPhotos !== null}
      &nbsp;sur {formatBytes(gmailPhotos)} de Gmail et Photos{/if}
  </span>
  <span class="grow"></span>
  {#if scanning}
    <button class="chip on" onclick={onshowscan}>Scan en cours · voir la progression</button>
  {:else if gmail.summary.lastScannedAt}
    <span class="muted">Dernière lecture le {new Date(gmail.summary.lastScannedAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
  {/if}
  <button class="btn small" onclick={onrescan} disabled={scanning}>↻ Actualiser</button>
</div>

{#if gmail.cleanup && gmail.cleanup.id !== closedCleanup}
  <CleanupPanel service={gmailCleanup} cleanup={gmail.cleanup} {failures} {onchange} onclose={() => (closedCleanup = gmail.cleanup?.id ?? null)} />
{/if}
{#if actionError}<div class="callout warn" role="alert">{actionError}</div>{/if}

<div class="main" class:nofilters={!filtersOpen}>
  {#if filtersOpen}
    <FiltersPanel {filters} {refreshKey} onchange={(next) => (filters = next)} />
  {/if}

  <div class="center">
    <div class="row wrap">
      <button class="btn small ghost" onclick={() => (filtersOpen = !filtersOpen)} aria-expanded={filtersOpen}>
        {filtersOpen ? '‹ Masquer les filtres' : 'Filtres ›'}
      </button>
      <span class="lbl">Niveaux</span>
      <div class="levels" role="list">
        {#each levels as axis, index (axis)}
          {#if index > 0}<span aria-hidden="true">›</span>{/if}
          <span
            class="level"
            role="listitem"
            draggable="true"
            ondragstart={() => (dragged = index)}
            ondragover={(event) => event.preventDefault()}
            ondrop={() => drop(index)}
            title="Glisser pour réordonner"
          >
            {AXIS_LABELS[axis]}
            <button aria-label="Retirer le niveau {AXIS_LABELS[axis]}" onclick={() => setLevels(levels.filter((other) => other !== axis))}>×</button>
          </span>
        {/each}
        {#if levels.length < MAX_LEVELS}
          <select
            class="input add"
            aria-label="Ajouter un niveau"
            value=""
            onchange={(event) => {
              setLevels([...levels, event.currentTarget.value as Axis]);
              event.currentTarget.value = '';
            }}
          >
            <option value="">+ niveau</option>
            {#each unused as axis (axis)}<option value={axis}>{AXIS_LABELS[axis]}</option>{/each}
          </select>
        {/if}
      </div>
      <span class="grow"></span>
      <div class="seg" role="group" aria-label="Affichage">
        <button class:on={mode === 'treemap'} aria-pressed={mode === 'treemap'} onclick={() => (mode = 'treemap')}>Treemap</button>
        <button class:on={mode === 'list'} aria-pressed={mode === 'list'} onclick={() => (mode = 'list')}>Liste triée</button>
        <button class:on={mode === 'attachments'} aria-pressed={mode === 'attachments'} onclick={() => (mode = 'attachments')}>Pièces jointes</button>
      </div>
      <select
        class="input"
        aria-label="Préréglage des niveaux"
        value={preset}
        onchange={(event) => setLevels(PRESETS[Number(event.currentTarget.value)]?.levels ?? levels)}
      >
        {#if preset < 0}<option value={-1}>Préréglage : personnalisé</option>{/if}
        {#each PRESETS as candidate, index (candidate.name)}<option value={index}>Préréglage : {candidate.name}</option>{/each}
      </select>
    </div>

    <div class="row wrap crumbs">
      <nav aria-label="Fil d'Ariane">
        <button disabled={path.length === 0} onclick={() => (path = [])}>Tout</button>
        {#each path as key, depth (depth)}
          › <button disabled={depth === path.length - 1} onclick={() => (path = path.slice(0, depth + 1))}>{axisValueLabel(levels[depth]!, key)}</button>
        {/each}
      </nav>
      {#if data}<span class="muted">· {data.tree.c.toLocaleString('fr-FR')} conversations · {formatBytes(data.tree.v)}</span>{/if}
      {#each chips as chip (chip.text)}
        <button class="chip on" onclick={chip.remove} title="Retirer ce filtre">{chip.text} ×</button>
      {/each}
    </div>

    {#if loadError}<div class="callout warn" role="alert">La lecture des résultats a échoué. Rechargez la page.</div>{/if}

    <div class="stage">
      <div class="view">
        {#if mode === 'treemap'}
          {#if data && data.tree.c > 0}
            <Treemap
              tree={data.tree}
              nameOf={(depth, key) => axisValueLabel(shown.levels[shown.path.length + depth]!, key)}
              colors={COLORS}
              selected={selectedIn.inbox}
              failed={failedIds}
              label="Treemap des messages reçus : une brique par conversation"
              onbrick={(brick, block, additive) =>
                pick({ id: brick.id, zone: 'inbox', size: brick.v }, { ...block, path: [...shown.path, ...block.path] }, additive)}
              onzoom={(relative) => (path = [...shown.path, ...relative])}
            />
          {:else if data}
            <p class="empty muted">Aucune conversation reçue ne correspond aux filtres.</p>
          {/if}
        {:else if mode === 'list'}
          <ConversationList
            {view}
            {refreshKey}
            selected={keys}
            onselect={(row, additive) => pick({ id: row.id, zone: row.zone, size: row.size }, null, additive)}
          />
        {:else}
          <AttachmentList
            {filters}
            {refreshKey}
            selected={keys}
            onselect={(attachment) => pick({ id: attachment.threadId, zone: attachment.zone, size: attachment.brickSize }, null, false)}
          />
        {/if}
      </div>

      {#if mode === 'treemap' && data}
        {#each ['sent', 'trash'] as const as zone (zone)}
          <div class="zone" class:closed={folded[zone]}>
            <div class="zone-head">
              <div class="row">
                {#if !folded[zone]}<b>{ZONE_LABELS[zone]}</b>{/if}
                <button
                  class="fold"
                  aria-expanded={!folded[zone]}
                  aria-label="{folded[zone] ? 'Déplier' : 'Replier'} la zone {ZONE_LABELS[zone]}"
                  onclick={() => (folded[zone] = !folded[zone])}>{folded[zone] ? '‹' : '›'}</button
                >
              </div>
              {#if folded[zone]}
                <span class="vertical">{ZONE_LABELS[zone]} · {formatBytes(data[zone].v)}</span>
              {:else}
                <span class="muted mono">{formatBytes(data[zone].v)}</span>
                <span class="muted">{zone === 'sent' ? 'et brouillons' : 'et spam, vidés sous 30 j'}</span>
              {/if}
            </div>
            {#if !folded[zone] && data[zone].c > 0}
              <div class="zone-body">
                <Treemap
                  tree={{ k: null, v: data[zone].v, c: data[zone].c, bricks: data[zone].bricks }}
                  colors={COLORS}
                  selected={selectedIn[zone]}
                  hatched={zone === 'trash'}
                  label="Zone {ZONE_LABELS[zone]}"
                  onbrick={(brick, _block, additive) => pick({ id: brick.id, zone, size: brick.v }, null, additive)}
                />
              </div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>

    <div class="legend">
      {#each Object.entries(ATT_TYPES) as [key, type] (key)}
        <button class:on={filters.axes?.attType?.values.includes(key)} onclick={() => toggleType(key)} title="Filtrer sur ce type">
          <i class="sw" style:background="var({type.color})"></i>{type.label}
        </button>
      {/each}
      <span class="grow"></span>
      <span class="hint">Ctrl+clic pour ajouter une brique à la sélection.</span>
    </div>
  </div>

  <DetailPanel
    {conversation}
    {email}
    block={focus?.block ? { name: blockName(focus.block.path) || 'Toute la vue', v: focus.block.v, c: focus.block.c } : null}
    onzoom={() => focus?.block && (path = focus.block.path)}
  >
    {#snippet actions()}
      {#if conversation?.otherZones.some((other) => other.zone !== 'trash')}
        <button class="btn small" onclick={addWholeConversation}>Sélectionner toute la conversation</button>
        <span class="hint">Ajoute ses messages {conversation.zone === 'sent' ? 'reçus' : 'envoyés (zone Envoyés)'}.</span>
      {/if}
    {/snippet}
    {#snippet blockActions()}
      <button class="btn small" onclick={() => focus?.block && addAll(focus.block.path, false)}>Sélectionner tout le bloc</button>
    {/snippet}
  </DetailPanel>
</div>

{#if conversation}
  <section class="msgs">
    <div class="row">
      <span class="lbl grow">
        E-mails de la sélection{#if picked.size > 1}
          &nbsp;· {picked.size.toLocaleString('fr-FR')} conversations sélectionnées, e-mails de la dernière cliquée{/if}
      </span>
      <span class="muted mono">{conversation.msgs} e-mail{conversation.msgs > 1 ? 's' : ''} · {formatBytes(conversation.size)}</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>De</th><th>À</th><th>Objet</th><th class="num">Date</th><th class="num">PJ</th><th class="num">Poids</th></tr>
        </thead>
        <tbody>
          {#each conversation.messages as message (message.id)}
            <tr>
              <td title={message.from}>{message.fromName || message.from}</td>
              <td title={message.to}>{message.to || '—'}</td>
              <td>{message.subject || '(sans objet)'}</td>
              <td class="num">{new Date(message.date).toLocaleDateString('fr-FR')}</td>
              <td class="num">{message.attCount ?? '?'}</td>
              <td class="num">{formatBytes(message.size)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </section>
{/if}
</div>

<ActionBar
  summary={gmailCleanup.count(picked.size)}
  size={pickedSize}
  empty={picked.size === 0}
  total={data?.tree.c ?? 0}
  bind:simulate
  blocked={scanning ? 'Nettoyage indisponible pendant un scan.' : cleaning ? 'Un nettoyage est en cours.' : null}
  needsAccess={!gmail.canClean}
  serviceName="Gmail"
  onselectall={() => addAll(path, true)}
  onclear={() => (picked = new Map())}
  onaction={(action) => (confirming = action)}
  onjournal={() => (showJournal = true)}
>
  {#snippet sorting(disabled)}
    <button class="btn small" {disabled} onclick={() => sort('archive')}>Archiver</button>
    <button class="btn small" {disabled} onclick={() => sort('read')}>Marquer lu</button>
    <button class="btn small" {disabled} onclick={() => sort('unread')}>Marquer non lu</button>
  {/snippet}
</ActionBar>

{#if confirming}
  <ConfirmDialog service={gmailCleanup} action={confirming} items={targets} {simulate} ondone={started} oncancel={() => (confirming = null)} />
{/if}
{#if showJournal}<JournalDialog service={gmailCleanup} onclose={() => (showJournal = false)} />{/if}

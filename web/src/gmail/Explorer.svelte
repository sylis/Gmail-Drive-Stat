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
    ZONE_LABELS,
    type Axis,
    type Conversation,
    type Filters,
    type GmailState,
    type TreemapData,
    type Zone,
  } from '../lib/gmail';
  import Treemap, { type Block, type Brick } from '../Treemap.svelte';
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
    onauth,
  }: {
    email: string;
    quota: Quota | null;
    state: GmailState;
    /** Change quand la base a été modifiée (scan qui avance) : les vues se rechargent. */
    refreshKey: number;
    onrescan: () => void;
    onshowscan: () => void;
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
  let loadError = $state(false);
  let filtersOpen = $state(true);
  let folded = $state<Record<'sent' | 'trash', boolean>>({ sent: false, trash: false });
  let dragged = $state<number | null>(null);

  let selection = $state<{ id: string; zone: Zone; block: Block | null } | null>(null);
  let conversation = $state<Conversation | null>(null);

  const view = $derived({ levels, path, filters });
  const selected = $derived(new Set(selection ? [selection.id] : []));
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
    const current = selection;
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
  }

  function drop(target: number) {
    if (dragged === null || dragged === target) return;
    const next = [...levels];
    next.splice(target, 0, ...next.splice(dragged, 1));
    dragged = null;
    setLevels(next);
  }

  function selectBrick(brick: Brick, block: Block) {
    selection = { id: brick.id, zone: 'inbox', block: { ...block, path: [...path, ...block.path] } };
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
              nameOf={(depth, key) => axisValueLabel(levels[path.length + depth]!, key)}
              colors={COLORS}
              {selected}
              label="Treemap des messages reçus : une brique par conversation"
              onbrick={selectBrick}
              onzoom={(relative) => (path = [...path, ...relative])}
            />
          {:else if data}
            <p class="empty muted">Aucune conversation reçue ne correspond aux filtres.</p>
          {/if}
        {:else if mode === 'list'}
          <ConversationList {view} {refreshKey} {selected} onselect={(row) => (selection = { id: row.id, zone: row.zone, block: null })} />
        {:else}
          <AttachmentList
            {filters}
            {refreshKey}
            {selected}
            onselect={(attachment) => (selection = { id: attachment.threadId, zone: attachment.zone, block: null })}
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
                  {selected}
                  hatched={zone === 'trash'}
                  label="Zone {ZONE_LABELS[zone]}"
                  onbrick={(brick) => (selection = { id: brick.id, zone, block: null })}
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
    </div>
  </div>

  <DetailPanel
    {conversation}
    {email}
    block={selection?.block ? { name: blockName(selection.block.path) || 'Toute la vue', v: selection.block.v, c: selection.block.c } : null}
    onzoom={() => selection?.block && (path = selection.block.path)}
  />
</div>

{#if conversation}
  <section class="msgs">
    <div class="row">
      <span class="lbl grow">E-mails de la sélection</span>
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

<style>
  .scopebar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 10px;
    padding: 8px 20px;
    border-bottom: 1px solid var(--line);
    background: var(--fill);
    font-size: 13px;
  }

  .main {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr) 270px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .main.nofilters {
    grid-template-columns: minmax(0, 1fr) 270px;
  }

  .main > :global(aside:first-child) {
    border-right: 1px solid var(--line);
  }

  .main > :global(aside:last-child) {
    border-left: 1px solid var(--line);
  }

  @media (max-width: 1000px) {
    .main,
    .main.nofilters {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .center {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    min-width: 0;
  }

  .wrap {
    flex-wrap: wrap;
  }

  .levels {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }

  .level {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    border: 1px solid var(--ink);
    border-radius: 6px;
    padding: 2px 4px 2px 8px;
    font-weight: 600;
    font-size: 12.5px;
    background: var(--surface);
    cursor: grab;
  }

  .level::before {
    content: '⋮⋮';
    color: var(--muted);
    letter-spacing: -2px;
    margin-right: 2px;
  }

  .level button {
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    cursor: pointer;
    padding: 0 4px;
  }

  .add {
    padding: 2px 6px;
    color: var(--muted);
  }

  .crumbs {
    font-size: 13px;
    gap: 6px;
  }

  .crumbs nav {
    font-family: var(--f-mono);
    font-size: 12.5px;
    color: var(--muted);
  }

  .crumbs nav button {
    font: inherit;
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
  }

  .crumbs nav button:disabled {
    color: var(--ink);
    text-decoration: none;
    cursor: default;
  }

  .stage {
    display: flex;
    gap: 8px;
    height: clamp(380px, calc(100vh - 300px), 900px);
  }

  .view {
    flex: 1;
    min-width: 0;
    border: 1px solid var(--line);
    border-radius: 6px;
    overflow: hidden;
    background: var(--fill);
  }

  .view:has(:global(.table-wrap)) {
    border: 0;
    background: none;
    overflow: visible;
  }

  .empty {
    padding: 24px;
  }

  .zone {
    width: 112px;
    flex: none;
    border: 1px dashed var(--line);
    border-radius: 6px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .zone.closed {
    width: 30px;
  }

  .zone-head {
    padding: 5px 6px;
    font-size: 11.5px;
    line-height: 1.3;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .zone-head .row {
    justify-content: space-between;
    gap: 4px;
  }

  .zone.closed .zone-head {
    align-items: center;
    padding: 6px 0;
  }

  .vertical {
    writing-mode: vertical-rl;
    transform: rotate(180deg);
    white-space: nowrap;
    margin-top: 6px;
  }

  .zone-body {
    flex: 1;
    min-height: 0;
    border-top: 1px dashed var(--line);
  }

  .fold {
    border: 1px solid var(--line);
    background: var(--surface);
    color: var(--ink);
    border-radius: 4px;
    font: 12px var(--f-mono);
    padding: 0 5px;
    cursor: pointer;
    line-height: 18px;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 6px;
  }

  .legend button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font: 12.5px var(--f-body);
    color: var(--ink);
    background: none;
    border: 1px solid transparent;
    border-radius: 999px;
    padding: 1px 8px;
    cursor: pointer;
  }

  .legend button:hover {
    border-color: var(--line);
  }

  .legend button.on {
    border-color: var(--accent);
    background: var(--accent-soft);
  }

  .msgs {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 12px 20px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .msgs .table-wrap {
    max-height: 240px;
  }
</style>

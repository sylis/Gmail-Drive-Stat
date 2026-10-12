<script lang="ts">
  import { formatBytes } from '../lib/format';
  import { ATT_TYPES, AXIS_LABELS, axisValueLabel, getFacet, type Axis, type FacetValue, type Filters } from '../lib/gmail';

  let {
    axis,
    filters,
    refreshKey,
    searchable = false,
    excludable = false,
    onchange,
  }: {
    axis: Axis;
    filters: Filters;
    refreshKey: number;
    searchable?: boolean;
    excludable?: boolean;
    onchange: (entry: { values: string[]; exclude?: boolean } | undefined) => void;
  } = $props();

  let open = $state(false);
  let search = $state('');
  let values = $state<FacetValue[]>([]);
  let loading = $state(false);

  const entry = $derived(filters.axes?.[axis]);
  const chosen = $derived(new Set(entry?.values ?? []));

  $effect(() => {
    void refreshKey;
    if (!open) return;
    const term = search;
    const current = filters;
    let stale = false;
    loading = true;
    // Courte attente : on ne relance pas la recherche à chaque frappe.
    const timer = setTimeout(async () => {
      try {
        const result = await getFacet(axis, current, term);
        if (!stale) values = result.values;
      } catch {
        if (!stale) values = [];
      } finally {
        if (!stale) loading = false;
      }
    }, 200);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  function toggle(value: string) {
    const next = chosen.has(value) ? [...chosen].filter((other) => other !== value) : [...chosen, value];
    onchange(next.length > 0 ? { values: next, exclude: entry?.exclude } : undefined);
  }
</script>

<div class="axis">
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    <span>{AXIS_LABELS[axis]}</span>
    <span class="muted">{entry ? (entry.exclude ? 'exclusion' : 'actif') : ''} {open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    {#if searchable}
      <input class="input" type="search" placeholder="Rechercher…" bind:value={search} aria-label="Rechercher dans {AXIS_LABELS[axis]}" />
    {/if}
    <div class="values">
      {#each values as item (item.value)}
        <label class="row" title={axisValueLabel(axis, item.value)}>
          <input type="checkbox" checked={chosen.has(item.value)} onchange={() => toggle(item.value)} />
          {#if axis === 'attType'}<i class="sw" style:background="var({ATT_TYPES[item.value]?.color ?? '--t-none'})"></i>{/if}
          <span class="grow name">{axisValueLabel(axis, item.value)}</span>
          <span class="mono muted">{formatBytes(item.size)}</span>
        </label>
      {:else}
        <span class="hint">{loading ? 'Lecture…' : 'Aucune valeur'}</span>
      {/each}
      {#if values.length >= 60}<span class="hint">60 premières valeurs : affinez par la recherche.</span>{/if}
    </div>
    {#if excludable && entry}
      <label class="row small">
        <input type="checkbox" checked={entry.exclude === true} onchange={() => onchange({ values: entry.values, exclude: !entry.exclude })} />
        Exclure au lieu d'inclure
      </label>
    {/if}
  {/if}
</div>

<style>
  .axis {
    border-bottom: 1px solid var(--fill2);
    padding-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font: 600 13px var(--f-body);
    color: var(--ink);
    background: none;
    border: 0;
    padding: 2px 0;
    cursor: pointer;
    text-align: left;
  }

  .head .muted {
    font-weight: 400;
    font-size: 12px;
  }

  .values {
    display: flex;
    flex-direction: column;
    gap: 3px;
    max-height: 220px;
    overflow: auto;
  }

  label {
    font-size: 12.5px;
    cursor: pointer;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .mono {
    font-size: 12px;
    white-space: nowrap;
  }

  .small {
    font-size: 12px;
    color: var(--muted);
  }
</style>

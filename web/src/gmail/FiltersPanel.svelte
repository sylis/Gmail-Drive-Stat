<script lang="ts">
  import type { Axis, Filters } from '../lib/gmail';
  import FacetFilter from './FacetFilter.svelte';

  let { filters, refreshKey, onchange }: { filters: Filters; refreshKey: number; onchange: (filters: Filters) => void } = $props();

  const MB = 1024 * 1024;
  const FACETS: { axis: Axis; searchable?: boolean; excludable?: boolean }[] = [
    { axis: 'label', searchable: true },
    { axis: 'sender', searchable: true, excludable: true },
    { axis: 'domain', searchable: true, excludable: true },
    { axis: 'list', searchable: true, excludable: true },
    { axis: 'group', searchable: true, excludable: true },
    { axis: 'attBucket' },
    { axis: 'attType' },
    { axis: 'category' },
  ];

  const active = $derived(Boolean(filters.dateFrom || filters.dateTo || filters.minSize || Object.keys(filters.axes ?? {}).length));

  function setAxis(axis: Axis, entry: { values: string[]; exclude?: boolean } | undefined) {
    const axes = { ...filters.axes };
    if (entry) axes[axis] = entry;
    else delete axes[axis];
    onchange({ ...filters, axes });
  }
</script>

<aside class="filters">
  <div class="row">
    <span class="lbl grow">Filtres</span>
    {#if active}<button class="link" onclick={() => onchange({})}>Tout effacer</button>{/if}
  </div>

  <div class="axis">
    <div class="head">Période <span class="muted">{filters.dateFrom || filters.dateTo ? 'actif' : ''}</span></div>
    <div class="row dates">
      <input
        class="input"
        type="date"
        value={filters.dateFrom ?? ''}
        aria-label="Du"
        onchange={(event) => onchange({ ...filters, dateFrom: event.currentTarget.value || undefined })}
      />
      <span aria-hidden="true">→</span>
      <input
        class="input"
        type="date"
        value={filters.dateTo ?? ''}
        aria-label="Au"
        onchange={(event) => onchange({ ...filters, dateTo: event.currentTarget.value || undefined })}
      />
    </div>
    <span class="hint">Date du dernier message de la conversation.</span>
  </div>

  {#each FACETS as facet (facet.axis)}
    <FacetFilter {...facet} {filters} {refreshKey} onchange={(entry) => setAxis(facet.axis, entry)} />
  {/each}

  <div class="axis last">
    <div class="head">Taille min. de la conversation <span class="muted">{filters.minSize ? 'actif' : ''}</span></div>
    <select
      class="input"
      aria-label="Taille minimale de la conversation"
      value={filters.minSize ?? 0}
      onchange={(event) => onchange({ ...filters, minSize: Number(event.currentTarget.value) || undefined })}
    >
      <option value={0}>Aucune</option>
      {#each [1, 5, 10, 25, 50] as size (size)}<option value={size * MB}>{size} Mo</option>{/each}
    </select>
  </div>
</aside>

<style>
  .filters {
    display: flex;
    flex-direction: column;
    gap: 10px;
    padding: 12px;
    min-width: 0;
  }

  .axis {
    border-bottom: 1px solid var(--fill2);
    padding-bottom: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .axis.last {
    border-bottom: 0;
  }

  .head {
    display: flex;
    justify-content: space-between;
    font-weight: 600;
    font-size: 13px;
  }

  .head .muted {
    font-weight: 400;
    font-size: 12px;
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
  }
</style>

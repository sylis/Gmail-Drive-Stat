<script lang="ts">
  import { formatBytes } from '../lib/format';
  import { ATT_TYPES, getList, ZONE_LABELS, type ListRow, type View, type Zone } from '../lib/gmail';

  let {
    view,
    refreshKey,
    selected,
    onselect,
  }: { view: View; refreshKey: number; selected: Set<string>; onselect: (row: ListRow, additive: boolean) => void } = $props();

  const COLUMNS: { key: string; label: string; num?: boolean }[] = [
    { key: 'subject', label: 'Conversation' },
    { key: 'domain', label: 'Domaine' },
    { key: 'date', label: 'Dernier msg' },
    { key: 'msgs', label: 'Msgs', num: true },
    { key: 'size', label: 'Taille', num: true },
  ];

  let zone = $state<Zone>('inbox');
  let sort = $state('size');
  let descending = $state(true);
  let rows = $state<ListRow[]>([]);
  let total = $state(0);
  let loading = $state(false);

  const max = $derived(Math.max(1, ...rows.map((row) => row.size)));

  async function load(offset: number) {
    loading = true;
    try {
      const page = await getList({ ...view, zone, sort, descending, offset });
      rows = offset === 0 ? page.rows : [...rows, ...page.rows];
      total = page.total;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void [view, refreshKey, zone, sort, descending];
    load(0);
  });

  function sortBy(key: string) {
    if (key === sort) descending = !descending;
    else {
      sort = key;
      descending = key === 'size' || key === 'date' || key === 'msgs';
    }
  }
</script>

<div class="wrap">
  <div class="row top">
    <div class="seg" role="group" aria-label="Zone">
      {#each Object.entries(ZONE_LABELS) as [key, label] (key)}
        <button class:on={zone === key} aria-pressed={zone === key} onclick={() => (zone = key as Zone)}>{label}</button>
      {/each}
    </div>
    <span class="muted">{total.toLocaleString('fr-FR')} conversations</span>
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
          <th>PJ</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row (row.id)}
          <tr class="clickable" class:sel={selected.has(row.id)} onclick={(event) => onselect(row, event.ctrlKey || event.metaKey)}>
            <td>{row.subject || '(sans objet)'}</td>
            <td>{row.domain}</td>
            <td class="num">{new Date(row.date).toLocaleDateString('fr-FR')}</td>
            <td class="num">{row.msgs}</td>
            <td class="num"><span class="szbar" style:width="{Math.round((row.size / max) * 40)}px"></span>{formatBytes(row.size)}</td>
            <td>
              <i class="sw" style:background="var({ATT_TYPES[row.attType]?.color ?? '--t-none'})" title={ATT_TYPES[row.attType]?.label}></i>
              {row.attCount ?? ''}
            </td>
          </tr>
        {:else}
          <tr><td colspan="6" class="muted">{loading ? 'Lecture…' : 'Aucune conversation ne correspond.'}</td></tr>
        {/each}
      </tbody>
    </table>
    {#if rows.length < total}
      <button class="btn small more" disabled={loading} onclick={() => load(rows.length)}>
        Afficher la suite ({rows.length.toLocaleString('fr-FR')} sur {total.toLocaleString('fr-FR')})
      </button>
    {/if}
  </div>
</div>

<style>
  .wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
    height: 100%;
    min-height: 0;
  }

  .top {
    justify-content: space-between;
  }

  .table-wrap {
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
</style>

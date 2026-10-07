<script lang="ts">
  import { formatBytes } from '../lib/format';
  import { ATT_TYPES, getTopAttachments, ZONE_LABELS, type Filters, type TopAttachment } from '../lib/gmail';

  let {
    filters,
    refreshKey,
    selected,
    onselect,
  }: { filters: Filters; refreshKey: number; selected: Set<string>; onselect: (attachment: TopAttachment) => void } = $props();

  let attachments = $state<TopAttachment[]>([]);
  let loading = $state(true);

  $effect(() => {
    void refreshKey;
    let stale = false;
    loading = true;
    getTopAttachments(filters)
      .then((result) => !stale && (attachments = result.attachments))
      .finally(() => !stale && (loading = false));
    return () => (stale = true);
  });
</script>

<div class="table-wrap">
  <table>
    <thead>
      <tr><th>Pièce jointe</th><th>Type</th><th>Conversation</th><th>De</th><th>Zone</th><th class="num">Date</th><th class="num">Taille</th></tr>
    </thead>
    <tbody>
      {#each attachments as attachment, index (index)}
        <tr class="clickable" class:sel={selected.has(attachment.threadId)} onclick={() => onselect(attachment)}>
          <td>{attachment.name}</td>
          <td><i class="sw" style:background="var({ATT_TYPES[attachment.type]?.color ?? '--t-oth'})"></i> {ATT_TYPES[attachment.type]?.label}</td>
          <td>{attachment.subject || '(sans objet)'}</td>
          <td>{attachment.from}</td>
          <td>{ZONE_LABELS[attachment.zone]}</td>
          <td class="num">{new Date(attachment.date).toLocaleDateString('fr-FR')}</td>
          <td class="num">{formatBytes(attachment.size)}</td>
        </tr>
      {:else}
        <tr>
          <td colspan="7" class="muted">
            {loading ? 'Lecture…' : 'Aucune pièce jointe détaillée pour ces filtres. Le scan détaille celles des messages de plus de 1 Mo, ou de tous selon le périmètre choisi.'}
          </td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .table-wrap {
    height: 100%;
  }
</style>

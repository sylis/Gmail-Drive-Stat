<script lang="ts">
  import { failureReason, type Cleanup, type CleanupItem, type CleanupService } from '../lib/cleanup';
  import { formatBytes } from '../lib/format';

  let { service, onclose }: { service: CleanupService; onclose: () => void } = $props();

  let cleanups = $state<Cleanup[] | null>(null);
  let opened = $state<number | null>(null);
  let items = $state<CleanupItem[]>([]);

  const STATUS: Record<Cleanup['status'], string> = {
    running: 'en cours',
    auth: 'en attente de reconnexion',
    done: 'terminé',
    cancelled: 'annulé',
    failed: 'interrompu',
  };
  const STATES: Record<CleanupItem['state'], string> = { done: 'fait', failed: 'échec', skipped: 'non traité', pending: 'en attente' };

  $effect(() => {
    service.journal().then(
      (result) => (cleanups = result.cleanups),
      () => (cleanups = []),
    );
  });

  async function toggle(id: number) {
    if (opened === id) {
      opened = null;
      return;
    }
    opened = id;
    items = [];
    items = (await service.items(id)).items;
  }
</script>

<svelte:window onkeydown={(event) => event.key === 'Escape' && onclose()} />

<div class="backdrop">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="journal-title">
    <header id="journal-title">Journal des nettoyages</header>
    <div class="body">
      {#if cleanups === null}
        <p class="muted">Lecture…</p>
      {:else if cleanups.length === 0}
        <p class="muted">Aucun nettoyage pour l'instant. Chaque action (corbeille, suppression, archivage, simulation) sera notée ici.</p>
      {:else}
        <ul>
          {#each cleanups as cleanup (cleanup.id)}
            {@const total = Object.values(cleanup.counts).reduce((sum, count) => sum + count.conversations, 0)}
            <li>
              <button class="entry" onclick={() => toggle(cleanup.id)} aria-expanded={opened === cleanup.id}>
                <span class="mono muted">{new Date(cleanup.createdAt).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' })}</span>
                <b>{service.actions[cleanup.action]?.name ?? cleanup.action}</b>
                {#if cleanup.simulate}<span class="chip">simulation</span>{/if}
                <span class="grow"></span>
                <span>
                  {cleanup.counts.done.conversations.toLocaleString('fr-FR')} / {service.count(total)} · {formatBytes(cleanup.counts.done.size)}
                </span>
                {#if cleanup.counts.failed.conversations > 0}<span class="fail">{cleanup.counts.failed.conversations} échec(s)</span>{/if}
                <span class="muted">{STATUS[cleanup.status]}</span>
                <span aria-hidden="true">{opened === cleanup.id ? '▾' : '▸'}</span>
              </button>
              {#if opened === cleanup.id}
                <div class="table-wrap">
                  <table>
                    <thead><tr><th>{service.itemLabel}</th><th>Origine</th><th>État</th><th class="num">Taille</th></tr></thead>
                    <tbody>
                      {#each items as item (item.zone + item.id)}
                        <tr>
                          <td>{item.subject || '(sans objet)'}</td>
                          <td>{item.domain}</td>
                          <td class:fail={item.state === 'failed'}>{STATES[item.state]}{item.state === 'failed' ? ` · ${failureReason(item.error)}` : ''}</td>
                          <td class="num">{formatBytes(item.size)}</td>
                        </tr>
                      {:else}
                        <tr><td colspan="4" class="muted">Lecture…</td></tr>
                      {/each}
                    </tbody>
                  </table>
                  {#if items.length >= 200}<p class="hint more">200 plus gros éléments affichés.</p>{/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <footer><button class="btn" onclick={onclose}>Fermer</button></footer>
  </div>
</div>

<style>
  .modal {
    width: min(100%, 860px);
    max-height: calc(100vh - 40px);
  }

  .body {
    overflow: auto;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }

  .entry {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    width: 100%;
    font: inherit;
    font-size: 13.5px;
    color: var(--ink);
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
    cursor: pointer;
  }

  .entry:hover {
    background: var(--fill);
  }

  .fail {
    color: var(--danger);
  }

  .table-wrap {
    margin: 6px 0 10px;
    max-height: 260px;
  }

  .more {
    padding: 6px 8px;
  }
</style>

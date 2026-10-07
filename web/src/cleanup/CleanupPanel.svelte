<script lang="ts">
  import { failureReason, type Cleanup, type CleanupItem, type CleanupService, type Target } from '../lib/cleanup';
  import { formatBytes } from '../lib/format';

  let {
    service,
    cleanup,
    failures,
    onchange,
    onclose,
  }: {
    service: CleanupService;
    cleanup: Cleanup;
    /** Éléments en échec du nettoyage affiché. */
    failures: CleanupItem[];
    /** L'état du serveur a changé : à relire. */
    onchange: () => void;
    onclose: () => void;
  } = $props();

  let busy = $state(false);
  let showFailures = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const n = (value: number) => value.toLocaleString('fr-FR');
  const total = $derived(Object.values(cleanup.counts).reduce((sum, count) => sum + count.conversations, 0));
  const treated = $derived(cleanup.counts.done.conversations + cleanup.counts.failed.conversations);
  const running = $derived(cleanup.status === 'running');
  const labels = $derived(service.actions[cleanup.action] ?? { name: cleanup.action, done: 'traitées' });
  const retryIn = $derived(cleanup.retryAt ? Math.max(0, Math.ceil((cleanup.retryAt - now) / 1000)) : 0);
  // Seules la corbeille et la suppression libèrent de la place.
  const frees = $derived(cleanup.action === 'trash' || cleanup.action === 'delete');

  const title = $derived.by(() => {
    const prefix = cleanup.simulate ? 'Simulation · ' : '';
    if (running) return `${prefix}${labels.name} en cours`;
    if (cleanup.status === 'auth') return `${prefix}${labels.name} · en attente de reconnexion`;
    const failed = cleanup.counts.failed.conversations;
    return [
      `${prefix}${service.count(cleanup.counts.done.conversations)} ${cleanup.simulate ? `auraient été ${labels.done}` : labels.done}`,
      ...(frees ? [formatBytes(cleanup.counts.done.size)] : []),
      ...(failed > 0 ? [`${n(failed)} échec${failed > 1 ? 's' : ''}`] : []),
      ...(cleanup.status === 'cancelled' ? ['arrêté avant la fin'] : []),
    ].join(' · ');
  });

  async function act(work: () => Promise<unknown>) {
    busy = true;
    try {
      await work();
    } catch {
      // L'état relu juste après dit ce qui s'est réellement passé.
    } finally {
      busy = false;
      onchange();
    }
  }

  const retry = (item?: Target) => act(() => service.retry(cleanup.id, item));
</script>

<section class="panel" class:warn={cleanup.counts.failed.conversations > 0 || cleanup.status === 'failed'} aria-live="polite">
  <div class="row head">
    <b class="grow">{title}</b>
    {#if running || cleanup.status === 'auth'}
      <span class="mono">{n(treated)} / {n(total)}</span>
      <button class="btn small ghost" disabled={busy} onclick={() => act(() => service.cancel())}>Arrêter</button>
    {:else}
      {#if cleanup.restorable}
        <button class="btn small" disabled={busy} onclick={() => act(() => service.restore(cleanup.id))}>Restaurer</button>
      {/if}
      {#if cleanup.counts.failed.conversations + cleanup.counts.skipped.conversations > 0 && !cleanup.simulate}
        <button class="btn small" disabled={busy} onclick={() => retry()}>Réessayer le reste</button>
      {/if}
      {#if cleanup.counts.failed.conversations > 0}
        <button class="btn small ghost" onclick={() => (showFailures = !showFailures)} aria-expanded={showFailures}>
          {showFailures ? 'Masquer les échecs' : 'Voir les échecs'}
        </button>
      {/if}
      <button class="btn small ghost" onclick={onclose} aria-label="Fermer ce bandeau">Fermer</button>
    {/if}
  </div>

  {#if running || cleanup.status === 'auth'}
    <div class="bar-track"><span style:width="{total > 0 ? (treated / total) * 100 : 0}%"></span></div>
    <div class="row counts">
      <span>Confirmations de {service.name} <b class="mono">{n(cleanup.counts.done.conversations)}</b></span>
      <span class:fail={cleanup.counts.failed.conversations > 0}>Échecs <b class="mono">{n(cleanup.counts.failed.conversations)}</b></span>
      <span class="muted">Reste <b class="mono">{n(cleanup.counts.pending.conversations)}</b></span>
      <span class="grow"></span>
      <span class="hint">L'affichage suit les confirmations de {service.name}. Le traitement continue si vous fermez l'onglet.</span>
    </div>
  {/if}

  {#if running && retryIn > 0}
    <div class="callout" role="status">{service.name} demande de ralentir. Reprise automatique dans <b class="mono">{retryIn} s</b>.</div>
  {:else if cleanup.status === 'auth'}
    <div class="callout warn" role="alert">
      {cleanup.error === 'autorisation-incomplete'
        ? `L'accès complet à ${service.name} n'a pas été accordé sur l'écran de Google.`
        : 'Google a mis fin à votre autorisation (mode test).'}
      Le traitement reprendra après la reconnexion. <a href="/auth/google?consent=1">Se reconnecter avec Google</a>
    </div>
  {:else if cleanup.status === 'failed'}
    <div class="callout warn" role="alert">
      {cleanup.error === 'google-indisponible' ? 'Google ne répond plus.' : 'Une erreur a interrompu le traitement.'}
      Ce qui a été fait est conservé ; « Réessayer le reste » reprend là où il s'est arrêté.
    </div>
  {:else if cleanup.status === 'done' && cleanup.action === 'trash' && !cleanup.simulate}
    <span class="hint">L'espace sera libéré au vidage de la corbeille. Pour le libérer tout de suite, sélectionnez la zone Corbeille et supprimez définitivement.</span>
  {/if}

  {#if showFailures && failures.length > 0}
    <ul class="failures">
      {#each failures as item (item.zone + item.id)}
        <li class="row">
          <span class="grow name" title={item.subject}>{item.subject || '(sans objet)'}</span>
          <span class="muted">{failureReason(item.error)}</span>
          <span class="mono muted">{formatBytes(item.size)}</span>
          <button class="btn small" disabled={busy || running} onclick={() => retry(item)}>Réessayer</button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 20px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--line);
    font-size: 13.5px;
  }

  .panel.warn {
    background: var(--danger-soft);
  }

  .head {
    flex-wrap: wrap;
  }

  .counts {
    flex-wrap: wrap;
    gap: 6px 18px;
  }

  .fail {
    color: var(--danger);
  }

  .callout {
    background: var(--surface);
  }

  .failures {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 4px;
    max-height: 180px;
    overflow: auto;
  }

  .failures li {
    background: var(--surface);
    border: 1px solid var(--danger);
    border-radius: 6px;
    padding: 4px 8px;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>

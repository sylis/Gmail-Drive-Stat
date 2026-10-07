<script lang="ts">
  import { ApiError } from '../lib/api';
  import type { CleanupPreview, CleanupService, Target } from '../lib/cleanup';
  import { formatBytes } from '../lib/format';

  let {
    service,
    action,
    items,
    simulate,
    ondone,
    oncancel,
  }: {
    service: CleanupService;
    action: 'trash' | 'delete';
    items: Target[];
    simulate: boolean;
    /** Le nettoyage a démarré sur le serveur. */
    ondone: () => void;
    oncancel: () => void;
  } = $props();

  let preview = $state<CleanupPreview | null>(null);
  let typed = $state('');
  let sending = $state(false);
  let error = $state<string | null>(null);

  const n = (value: number) => value.toLocaleString('fr-FR');
  const danger = $derived(action === 'delete');
  // Confirmation renforcée : le bouton reste grisé tant que le bon nombre n'est pas saisi.
  const confirmed = $derived(preview !== null && (!danger || Number(typed.replace(/\s/g, '')) === preview.conversations));

  $effect(() => {
    service.preview(items).then(
      (result) => (preview = result),
      () => (error = 'Le récapitulatif n’a pas pu être calculé.'),
    );
  });

  const MESSAGES = $derived<Record<string, string>>({
    'scan-en-cours': 'Un scan est en cours : attendez sa fin avant de nettoyer.',
    'nettoyage-en-cours': 'Un nettoyage est déjà en cours.',
    'autorisation-incomplete': `L'accès complet à ${service.name} n'a pas été accordé. Reconnectez-vous pour l'autoriser, ou utilisez le mode simulation.`,
    'confirmation-requise': 'La sélection a changé depuis le récapitulatif. Fermez cette fenêtre et recommencez.',
    'selection-vide': 'Ces éléments ne sont plus en base. Relancez un scan.',
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!preview || !confirmed) return;
    sending = true;
    error = null;
    try {
      await service.start({ action, items, simulate, ...(danger ? { confirm: preview.conversations } : {}) });
      ondone();
    } catch (cause) {
      error = (cause instanceof ApiError && MESSAGES[cause.code]) || 'Le nettoyage n’a pas pu démarrer.';
    } finally {
      sending = false;
    }
  }
</script>

<div class="backdrop">
  <form class="modal" class:danger onsubmit={submit} aria-labelledby="confirm-title">
    <header id="confirm-title">
      {#if simulate}Simulation ·{/if}
      {#if !preview}
        {service.actions[action]?.name}
      {:else if danger}
        Supprimer définitivement {service.count(preview.conversations)}
      {:else}
        Mettre {service.count(preview.conversations)} à la corbeille ?
      {/if}
    </header>
    <div class="body">
      {#if preview}
        <div class="mini">
          <span>{service.itemLabel}s</span><span class="mono">{n(preview.conversations)}</span>
          {#if preview.messages !== preview.conversations}<span>Messages</span><span class="mono">{n(preview.messages)}</span>{/if}
          <span>{danger ? 'Espace libéré immédiatement' : 'Espace concerné'}</span><span class="mono"><b>{formatBytes(preview.size)}</b></span>
        </div>

        {#if danger}
          <div class="col biggest">
            <span class="lbl">Les plus grosses</span>
            <div class="mini muted">
              {#each preview.top as top, index (index)}
                <span class="name">{top.subject || '(sans objet)'}</span><span class="mono">{formatBytes(top.size)}</span>
              {/each}
              {#if preview.conversations > preview.top.length}
                <span>… et {n(preview.conversations - preview.top.length)} autres</span><span></span>
              {/if}
            </div>
          </div>
        {/if}

        {#if service.flaggedWarning(preview.flagged)}
          <div class="callout warn" role="alert"><b>Attention.</b> {service.flaggedWarning(preview.flagged)}</div>
        {/if}

        {#if simulate}
          <div class="callout">Mode simulation : rien ne sera envoyé à {service.name}, rien ne sera modifié. Le résultat sera noté dans le journal.</div>
        {:else if danger}
          <div class="callout warn"><b>Irréversible.</b> {service.name} ne propose aucune restauration après une suppression définitive.</div>
        {:else}
          <div class="callout">{service.trashNote}</div>
        {/if}

        {#if danger}
          <label class="col">
            <span>Pour confirmer, saisissez le nombre de {service.itemLabel.toLowerCase()}s : <b class="mono">{n(preview.conversations)}</b></span>
            <!-- svelte-ignore a11y_autofocus -->
            <input class="input" inputmode="numeric" autocomplete="off" autofocus bind:value={typed} />
          </label>
        {/if}
      {:else if !error}
        <p class="muted">Calcul du récapitulatif…</p>
      {/if}
      {#if error}<div class="callout warn" role="alert">{error}</div>{/if}
    </div>
    <footer>
      <button type="button" class="btn ghost" onclick={oncancel}>Annuler</button>
      <button class="btn danger" class:solid={danger} disabled={!confirmed || sending}>
        {simulate ? 'Simuler' : danger ? 'Supprimer définitivement' : 'Mettre à la corbeille'}
      </button>
    </footer>
  </form>
</div>

<style>
  .modal {
    width: min(100%, 480px);
  }

  .modal.danger {
    border-color: var(--danger);
  }

  .modal.danger > header {
    background: var(--danger-soft);
    color: var(--danger);
    border-color: var(--danger);
    border-radius: 9px 9px 0 0;
  }

  .mini {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 12px;
    font-size: 14px;
  }

  .mini .mono {
    text-align: right;
  }

  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .biggest {
    gap: 5px;
  }

  .biggest .mini {
    font-size: 13px;
  }

  .btn:disabled {
    cursor: not-allowed;
    opacity: 0.4;
  }
</style>

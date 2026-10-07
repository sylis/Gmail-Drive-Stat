<script lang="ts">
  import { formatBytes } from '../lib/format';
  import { describeScope, scanAction, type GmailState, type ScanProgress } from '../lib/gmail';

  let {
    scan,
    state: gmail,
    onchange,
    onexplore,
  }: { scan: ScanProgress; state: GmailState; onchange: () => void; onexplore: () => void } = $props();

  let busy = $state(false);
  let now = $state(Date.now());

  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  const n = (value: number) => value.toLocaleString('fr-FR');
  const ORDER = ['list', 'read', 'attachments'] as const;
  const stepState = (step: (typeof ORDER)[number]) => {
    if (scan.status === 'done') return 'done';
    const current = ORDER.indexOf(scan.step);
    const index = ORDER.indexOf(step);
    return index < current ? 'done' : index === current ? 'current' : 'wait';
  };
  const percent = (done: number, total: number) => (total > 0 ? Math.min(100, (done / total) * 100) : 0);
  const retryIn = $derived(scan.retryAt ? Math.max(0, Math.ceil((scan.retryAt - now) / 1000)) : 0);
  const title = $derived(
    { running: 'Scan en cours', paused: 'Scan en pause', auth: 'Scan suspendu', done: 'Scan terminé', cancelled: 'Scan annulé', failed: 'Scan interrompu' }[
      scan.status
    ],
  );

  function eta(seconds: number | null): string {
    if (seconds === null) return 'estimation en cours…';
    if (seconds < 60) return 'moins d’une minute restante (estimation)';
    const minutes = Math.round(seconds / 60);
    return minutes < 60
      ? `≈ ${minutes} min restantes (estimation)`
      : `≈ ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} restantes (estimation)`;
  }

  async function act(action: 'pause' | 'resume' | 'cancel') {
    busy = true;
    try {
      await scanAction(action);
    } finally {
      busy = false;
      onchange();
    }
  }
</script>

<main>
  <section class="card steps">
    <h2>{title} · {describeScope(scan.scope, gmail.labels).join(', ')}</h2>

    <div class="step">
      <span class="st {stepState('list')}">{stepState('list') === 'done' ? '✓' : '1'}</span>
      <div class="col">
        <b>Liste des conversations</b>
        <span class="muted mono">
          {n(scan.threadsTotal)} conversations{#if stepState('list') === 'current' && scan.stats.labelsTotal > 1}
            · libellé {scan.stats.labelsDone + 1} sur {scan.stats.labelsTotal}{/if}
        </span>
      </div>
    </div>

    <div class="step">
      <span class="st {stepState('read')}">{stepState('read') === 'done' ? '✓' : '2'}</span>
      <div class="col">
        <div class="row"><b class="grow" class:muted={stepState('read') === 'wait'}>Lecture des métadonnées</b>
          {#if stepState('read') !== 'wait'}<span class="mono">{n(scan.threadsDone)} / {n(scan.threadsTotal)}</span>{/if}</div>
        {#if stepState('read') === 'current'}
          <div class="bar-track"><span style:width="{percent(scan.threadsDone, scan.threadsTotal)}%"></span></div>
          {#if scan.status === 'running'}<span class="muted mono">{eta(scan.etaSeconds)}</span>{/if}
        {:else if stepState('read') === 'wait'}
          <span class="muted">En attente</span>
        {/if}
      </div>
    </div>

    <div class="step">
      <span class="st {stepState('attachments')}">{stepState('attachments') === 'done' ? '✓' : '3'}</span>
      <div class="col">
        <div class="row"><b class="grow" class:muted={stepState('attachments') === 'wait'}>Détail des pièces jointes</b>
          {#if stepState('attachments') !== 'wait'}<span class="mono">{n(scan.stats.detailDone)} / {n(scan.stats.detailTotal)}</span>{/if}</div>
        {#if stepState('attachments') === 'current'}
          <div class="bar-track"><span style:width="{percent(scan.stats.detailDone, scan.stats.detailTotal)}%"></span></div>
          {#if scan.status === 'running' && scan.stats.detailTotal > 0}<span class="muted mono">{eta(scan.etaSeconds)}</span>{/if}
        {:else if stepState('attachments') === 'wait'}
          <span class="muted">
            En attente · {scan.scope.attachmentDetail === 'all' ? 'lu en même temps que les métadonnées' : 'messages de plus de 1 Mo'}
          </span>
        {/if}
      </div>
    </div>

    {#if scan.status === 'running' && retryIn > 0}
      <div class="callout" role="status">Gmail demande de ralentir. Reprise automatique dans <b class="mono">{retryIn} s</b>.</div>
    {:else if scan.status === 'auth'}
      <div class="callout warn" role="alert">
        {#if scan.error === 'autorisation-incomplete'}
          La lecture de Gmail n'a pas été autorisée sur l'écran de Google. Reconnectez-vous en cochant l'accès à Gmail :
        {:else}
          Google a mis fin à votre autorisation (mode test). Reconnectez-vous :
        {/if}
        le scan reprendra où il s'était arrêté. <a href="/auth/google?consent=1">Se reconnecter avec Google</a>
      </div>
    {:else if scan.status === 'failed'}
      <div class="callout warn" role="alert">
        {scan.error === 'google-indisponible' ? 'Google ne répond plus.' : 'Une erreur a interrompu le scan.'}
        Ce qui a été lu est conservé : relancez un scan pour continuer, seul le reste sera lu.
      </div>
    {:else if scan.status === 'paused'}
      <div class="callout" role="status">Scan en pause. Rien n'est perdu : il reprendra où il s'était arrêté.</div>
    {/if}

    <div class="row actions">
      {#if scan.status === 'running'}
        <button class="btn" disabled={busy} onclick={() => act('pause')}>Mettre en pause</button>
      {:else if scan.status === 'paused'}
        <button class="btn primary" disabled={busy} onclick={() => act('resume')}>Reprendre</button>
      {/if}
      {#if scan.status === 'running' || scan.status === 'paused' || scan.status === 'auth'}
        <button class="btn ghost" disabled={busy} onclick={() => act('cancel')}>Annuler le scan</button>
      {/if}
    </div>
    <p class="hint">Le scan tourne sur le serveur : vous pouvez fermer l'onglet et revenir plus tard. Interrompu, il reprend où il s'était arrêté.</p>
  </section>

  <section class="col side">
    <span class="lbl">Déjà lu par ce scan</span>
    <div class="stats">
      <div class="stat"><span class="lbl">Messages lus</span><b class="mono">{n(scan.stats.messagesRead)}</b></div>
      <div class="stat"><span class="lbl">Volume lu</span><b class="mono">{formatBytes(scan.stats.bytesRead)}</b><span class="hint">taille des messages lus</span></div>
      <div class="stat">
        <span class="lbl">Conversations</span><b class="mono">{n(scan.threadsDone)}</b><span class="hint mono">sur {n(scan.threadsTotal)}</span>
      </div>
      <div class="stat">
        <span class="lbl">Pièces jointes</span><b class="mono">{n(scan.stats.attachmentsFound)}</b>
        <span class="hint">{stepState('attachments') === 'wait' && scan.scope.attachmentDetail === 'large' ? 'détaillées à l’étape 3' : 'détaillées'}</span>
      </div>
      <div class="stat">
        <span class="lbl">Adresses e-mail</span><b class="mono">{n(gmail.summary.addresses)}</b>
        <span class="hint">en base, dont {n(gmail.summary.domains)} domaines</span>
      </div>
      <div class="stat">
        <span class="lbl">En base</span><b class="mono">{n(gmail.summary.conversations)}</b><span class="hint">conversations, tous scans confondus</span>
      </div>
    </div>
    <div class="row">
      <span class="grow hint">Le treemap s'ouvre sur ce qui est déjà en base, avec un bandeau « scan en cours ».</span>
      <button class="btn" disabled={gmail.summary.conversations === 0} onclick={onexplore}>
        {scan.status === 'done' ? 'Voir les résultats' : 'Explorer les résultats partiels'}
      </button>
    </div>
  </section>
</main>

<style>
  main {
    max-width: 1100px;
    margin: 0 auto;
    padding: 24px;
    display: grid;
    grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr);
    gap: 24px;
    align-items: start;
  }

  @media (max-width: 820px) {
    main {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  h2 {
    font-size: 18px;
    margin-bottom: 6px;
  }

  .steps {
    display: grid;
    gap: 4px;
  }

  .step {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: 4px 10px;
    padding: 12px 0;
    border-bottom: 1px solid var(--fill2);
  }

  .step .col {
    gap: 5px;
  }

  .st {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1.5px solid var(--ink);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 11px;
  }

  .st.done {
    background: var(--ink);
    color: var(--surface);
  }

  .st.wait {
    border-style: dashed;
    border-color: var(--muted);
    color: var(--muted);
  }

  .actions {
    margin-top: 12px;
  }

  .callout {
    margin-top: 12px;
  }

  .side {
    gap: 12px;
  }

  .stats {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
  }

  .stat {
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .stat b {
    font-size: 19px;
    font-weight: 600;
  }
</style>

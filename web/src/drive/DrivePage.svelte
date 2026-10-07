<script lang="ts">
  import { ApiError, type Quota } from '../lib/api';
  import { cancelDriveScan, getDriveState, startDriveScan, type DriveState } from '../lib/drive';
  import DriveExplorer from './DriveExplorer.svelte';

  let { quota, onchange }: { quota: Quota | null; onchange: () => void } = $props();

  let drive = $state<DriveState | null>(null);
  let unreachable = $state(false);
  let refreshKey = $state(0);
  let scanError = $state<string | null>(null);
  let now = $state(Date.now());

  const scanning = $derived(drive?.scan?.status === 'running' || drive?.scan?.status === 'auth');
  const cleaning = $derived(drive?.cleanup != null && ['running', 'auth'].includes(drive.cleanup.status));
  const hasData = $derived((drive?.summary.files.count ?? 0) + (drive?.summary.trash.count ?? 0) > 0 || drive?.summary.lastScannedAt != null);
  const retryIn = $derived(drive?.scan?.retryAt ? Math.max(0, Math.ceil((drive.scan.retryAt - now) / 1000)) : 0);

  let lastSeen = '';
  async function refresh() {
    try {
      const next = await getDriveState();
      // Les vues se rechargent à la fin d'un scan, et à chaque confirmation de Drive pendant un nettoyage.
      const seen = JSON.stringify([next.scan?.id, next.scan?.status, next.cleanup?.id, next.cleanup?.status, next.cleanup?.counts]);
      if (seen !== lastSeen) {
        if (lastSeen !== '') refreshKey++;
        lastSeen = seen;
      }
      drive = next;
      unreachable = false;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onchange();
      unreachable = true;
    }
  }

  async function scan() {
    scanError = null;
    try {
      await startDriveScan();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onchange();
      scanError =
        cause instanceof ApiError && cause.code === 'nettoyage-en-cours'
          ? 'Un nettoyage est en cours : attendez sa fin avant de relire le Drive.'
          : 'Le scan n’a pas pu démarrer.';
    }
    refresh();
  }

  async function cancel() {
    await cancelDriveScan().catch(() => undefined);
    refresh();
  }

  $effect(() => {
    const timer = setInterval(() => {
      now = Date.now();
      if (scanning || cleaning) refresh();
    }, 1500);
    return () => clearInterval(timer);
  });

  refresh();
</script>

{#if unreachable && !drive}
  <main class="center"><div class="callout warn" role="alert">Le serveur ne répond pas. Rechargez la page dans un instant.</div></main>
{:else if !drive}
  <main class="center"><p class="muted">Chargement…</p></main>
{:else if !drive.authorized}
  <main class="center">
    <div class="card intro">
      <h2>Autoriser la lecture de Drive</h2>
      <p class="muted">
        Pour mesurer ce qui occupe votre Drive, l'outil a besoin de la liste de vos fichiers. Il ne lit que des métadonnées (nom, dossier,
        type, taille, date), jamais le contenu. Rien ne quitte ce serveur.
      </p>
      <a class="btn primary" href="/auth/google?consent=1">Autoriser avec Google</a>
    </div>
  </main>
{:else}
  {#if scanning && drive.scan}
    <div class="scanbar" role="status">
      <b class="grow">
        {drive.scan.status === 'auth' ? 'Scan du Drive suspendu' : 'Scan du Drive en cours'} · {drive.scan.seen.toLocaleString('fr-FR')} fichiers et
        dossiers lus
      </b>
      {#if drive.scan.status === 'auth'}
        <span>
          {drive.scan.error === 'autorisation-incomplete' ? 'La lecture de Drive n’a pas été autorisée.' : 'Google a mis fin à votre autorisation (mode test).'}
          <a href="/auth/google?consent=1">Se reconnecter avec Google</a>
        </span>
      {:else if retryIn > 0}
        <span>Drive demande de ralentir. Reprise dans <b class="mono">{retryIn} s</b>.</span>
      {/if}
      <button class="btn small ghost" onclick={cancel}>Annuler le scan</button>
    </div>
  {:else if drive.scan?.status === 'failed'}
    <div class="scanbar warn" role="alert">
      <span class="grow">
        {drive.scan.error === 'google-indisponible' ? 'Google ne répond plus : le scan du Drive s’est interrompu.' : 'Une erreur a interrompu le scan du Drive.'}
        Les résultats du scan précédent restent affichés.
      </span>
      <button class="btn small" onclick={scan}>Relancer</button>
    </div>
  {/if}
  {#if scanError}<div class="scanbar warn" role="alert">{scanError}</div>{/if}

  {#if hasData}
    <DriveExplorer {quota} state={drive} {refreshKey} {scanning} onrescan={scan} onchange={refresh} onauth={onchange} />
  {:else if !scanning}
    <main class="center">
      <div class="card intro">
        <h2>Analyser votre Drive</h2>
        <p class="muted">
          Un scan lit la liste de vos fichiers et les range dans un treemap par dossier, comme WinDirStat : une brique par fichier, d'autant
          plus grande qu'il pèse lourd. Seuls les fichiers dont vous êtes propriétaire sont comptés : ce sont les seuls qui occupent votre
          quota.
        </p>
        <button class="btn primary" onclick={scan}>Scanner mon Drive</button>
      </div>
    </main>
  {/if}
{/if}

<style>
  .center {
    display: grid;
    place-items: center;
    padding: 48px 24px;
  }

  .intro {
    display: grid;
    gap: 14px;
    justify-items: start;
    max-width: 560px;
  }

  h2 {
    font-size: 20px;
  }

  .scanbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 14px;
    padding: 10px 20px;
    background: var(--accent-soft);
    border-bottom: 1px solid var(--line);
    font-size: 13.5px;
  }

  .scanbar.warn {
    background: var(--danger-soft);
  }
</style>

<script lang="ts">
  import { ApiError, type Quota, type Status } from '../lib/api';
  import { getGmailState, type GmailState } from '../lib/gmail';
  import Explorer from './Explorer.svelte';
  import ScanProgress from './ScanProgress.svelte';
  import ScopeDialog from './ScopeDialog.svelte';

  let { user, quota, onchange }: { user: NonNullable<Status['user']>; quota: Quota | null; onchange: () => void } = $props();

  let gmail = $state<GmailState | null>(null);
  let unreachable = $state(false);
  /** Écran demandé par l'utilisateur ; par défaut la progression tant qu'un scan tourne, sinon les résultats. */
  let screen = $state<'auto' | 'scan' | 'explore'>('auto');
  let choosingScope = $state(false);
  let refreshKey = $state(0);

  const active = $derived(gmail?.scan != null && ['running', 'paused', 'auth'].includes(gmail.scan.status));
  const hasData = $derived((gmail?.summary.conversations ?? 0) > 0);
  const showScan = $derived(gmail?.scan != null && (screen === 'scan' || (screen === 'auto' && active) || (!hasData && !active)));

  let lastDone = -1;
  async function refresh() {
    try {
      const next = await getGmailState();
      // Les vues se rechargent quand le scan a avancé d'un cran visible, et à sa fin.
      const done = next.scan ? next.scan.threadsDone + next.scan.stats.detailDone : 0;
      const finished = gmail?.scan?.status === 'running' && next.scan?.status !== 'running';
      if (finished || Math.abs(done - lastDone) >= Math.max(200, (next.scan?.threadsTotal ?? 0) / 20)) {
        lastDone = done;
        refreshKey++;
      }
      gmail = next;
      unreachable = false;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onchange();
      unreachable = true;
    }
  }

  $effect(() => {
    // Tant qu'un scan tourne, l'avancement est relu chaque seconde et demie ; sinon une fois suffit.
    const timer = setInterval(() => active && refresh(), 1500);
    return () => clearInterval(timer);
  });

  refresh();
</script>

{#if unreachable && !gmail}
  <main class="center"><div class="callout warn" role="alert">Le serveur ne répond pas. Rechargez la page dans un instant.</div></main>
{:else if !gmail}
  <main class="center"><p class="muted">Chargement…</p></main>
{:else if !gmail.authorized}
  <main class="center">
    <div class="card intro">
      <h2>Autoriser la lecture de Gmail</h2>
      <p class="muted">
        Pour mesurer ce qui occupe votre boîte, l'outil a besoin de lire vos e-mails. Il ne lit que des métadonnées (taille, date,
        expéditeur, destinataires, objet, libellés, nom et taille des pièces jointes), jamais le contenu. Rien ne quitte ce serveur.
      </p>
      <p class="muted">Google vous montrera un écran d'autorisation : cochez l'accès à Gmail.</p>
      <a class="btn primary" href="/auth/google?consent=1">Autoriser avec Google</a>
    </div>
  </main>
{:else if showScan && gmail.scan}
  <ScanProgress scan={gmail.scan} state={gmail} onchange={refresh} onexplore={() => (screen = 'explore')} />
  {#if !active}
    <div class="again"><button class="btn primary" onclick={() => (choosingScope = true)}>Lancer un nouveau scan</button></div>
  {/if}
{:else if hasData}
  <Explorer
    email={user.email}
    {quota}
    state={gmail}
    {refreshKey}
    onrescan={() => (choosingScope = true)}
    onshowscan={() => (screen = 'scan')}
    onauth={onchange}
  />
{:else}
  <main class="center">
    <div class="card intro">
      <h2>Analyser votre boîte Gmail</h2>
      <p class="muted">
        Un scan lit les métadonnées de vos conversations et les range dans un treemap : une brique par conversation, d'autant plus
        grande qu'elle pèse lourd. Vous choisissez d'abord ce que vous voulez analyser.
      </p>
      <button class="btn primary" onclick={() => (choosingScope = true)}>Choisir le périmètre</button>
    </div>
  </main>
{/if}

{#if choosingScope && gmail}
  <ScopeDialog
    state={gmail}
    onstarted={() => {
      choosingScope = false;
      screen = 'auto';
      refresh();
    }}
    oncancel={() => (choosingScope = false)}
    onauth={onchange}
  />
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

  .again {
    display: flex;
    justify-content: center;
    padding-bottom: 32px;
  }
</style>

<script lang="ts">
  import { ApiError, getQuota, logout, type Quota, type Status } from './lib/api';
  import { formatBytes, formatPercent } from './lib/format';
  import DrivePage from './drive/DrivePage.svelte';
  import GmailPage from './gmail/GmailPage.svelte';
  import Overview from './Overview.svelte';

  let { user, onchange }: { user: NonNullable<Status['user']>; onchange: () => void } = $props();

  type Page = 'overview' | 'gmail' | 'drive';
  const pageOf = (hash: string): Page => (hash.startsWith('#/gmail') ? 'gmail' : hash.startsWith('#/drive') ? 'drive' : 'overview');

  let page = $state<Page>(pageOf(location.hash));
  let quota = $state<Quota | null>(null);
  let quotaLoading = $state(false);
  let quotaError = $state<string | null>(null);

  async function loadQuota() {
    quotaLoading = true;
    quotaError = null;
    try {
      quota = await getQuota();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onchange();
      quotaError =
        cause instanceof ApiError && cause.code === 'autorisation-incomplete'
          ? 'La lecture du quota Drive n’a pas été autorisée sur l’écran de Google. Déconnectez-vous puis reconnectez-vous en cochant toutes les autorisations.'
          : 'Google n’a pas répondu. Réessayez dans un instant.';
    } finally {
      quotaLoading = false;
    }
  }

  async function signOut() {
    await logout();
    onchange();
  }

  $effect(() => {
    const onhash = () => (page = pageOf(location.hash));
    window.addEventListener('hashchange', onhash);
    return () => window.removeEventListener('hashchange', onhash);
  });

  loadQuota();
</script>

<header class="bar">
  <h1><span class="logo" aria-hidden="true"><i></i><i></i><i></i></span>Gmail Drive Stat</h1>
  <nav aria-label="Sections">
    <a href="#/" class:on={page === 'overview'} aria-current={page === 'overview' ? 'page' : undefined}>Vue globale</a>
    <a href="#/gmail" class:on={page === 'gmail'} aria-current={page === 'gmail' ? 'page' : undefined}>Gmail</a>
    <a href="#/drive" class:on={page === 'drive'} aria-current={page === 'drive' ? 'page' : undefined}>Drive</a>
  </nav>
  <span class="grow"></span>
  {#if quota && quota.limit !== null}
    <a class="gauge" href="#/" title="Voir la répartition du stockage">
      <span class="row"
        ><span>{formatBytes(quota.usage)} sur {formatBytes(quota.limit)}</span><span class="muted"
          >{formatPercent(quota.usage, quota.limit)}</span
        ></span
      >
      <span class="bar-track"><span style:width="{Math.min(100, (quota.usage / quota.limit) * 100)}%"></span></span>
    </a>
  {/if}
  <span class="who">
    {#if user.picture}<img src={user.picture} alt="" referrerpolicy="no-referrer" />{/if}
    <span class="muted">{user.email}</span>
  </span>
  <button class="btn small" onclick={signOut}>Se déconnecter</button>
</header>

{#if page === 'gmail'}
  <GmailPage {user} {quota} {onchange} />
{:else if page === 'drive'}
  <DrivePage {quota} {onchange} />
{:else}
  <Overview {quota} loading={quotaLoading} error={quotaError} onreload={loadQuota} {onchange} />
{/if}

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
    padding: 10px 20px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  h1 {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: 19px;
    font-weight: 800;
    letter-spacing: -0.02em;
  }

  /* Trois colis empilés, aux couleurs des pièces jointes les plus fréquentes. */
  .logo {
    width: 20px;
    height: 20px;
    display: grid;
    grid-template-columns: 2fr 1fr;
    grid-template-rows: 1fr 1fr;
    gap: 2px;
  }

  .logo i {
    border-radius: 3px;
    background: var(--t-vid);
  }

  .logo i:first-child {
    grid-row: span 2;
  }

  .logo i:nth-child(2) {
    background: var(--t-zip);
  }

  .logo i:nth-child(3) {
    background: var(--t-img);
  }

  nav {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  nav a {
    padding: 5px 13px;
    border-radius: var(--r-pill);
    color: var(--muted);
    text-decoration: none;
    font-weight: 700;
    transition:
      background 0.15s,
      color 0.15s;
  }

  nav a:hover {
    background: var(--fill);
    color: var(--ink);
  }

  nav a.on {
    background: var(--ink);
    color: var(--surface);
  }

  .gauge {
    display: grid;
    gap: 3px;
    width: 200px;
    font-size: 12px;
    color: var(--ink);
    text-decoration: none;
  }

  .gauge .row {
    justify-content: space-between;
  }

  .gauge {
    font-family: var(--f-mono);
  }

  .gauge .bar-track {
    height: 6px;
  }

  .gauge .bar-track > span {
    background: var(--ink);
  }

  .who {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  .who img {
    width: 26px;
    height: 26px;
    border-radius: 50%;
  }
</style>

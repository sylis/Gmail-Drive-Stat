<script lang="ts">
  import { ApiError, getQuota, logout, revokeAccount, type Quota, type QuotaPartKey, type Status } from './lib/api';
  import { formatBytes, formatPercent } from './lib/format';
  import QuotaTreemap from './QuotaTreemap.svelte';

  let { user, onchange }: { user: NonNullable<Status['user']>; onchange: () => void } = $props();

  const PARTS: Record<QuotaPartKey, { label: string; colorVar: string; note: string }> = {
    gmailPhotos: {
      label: 'Gmail et Photos',
      colorVar: '--q-gmail',
      note: 'Google ne distingue pas les deux ; le scan Gmail donnera le détail.',
    },
    drive: { label: 'Drive', colorVar: '--q-drive', note: 'Vos fichiers Drive, hors corbeille.' },
    driveTrash: {
      label: 'Corbeille Drive',
      colorVar: '--q-trash',
      note: 'Compte dans le quota tant que la corbeille n’est pas vidée.',
    },
    free: { label: 'Libre', colorVar: '--q-free', note: 'Espace encore disponible.' },
  };

  let quota = $state<Quota | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let confirmRevoke = $state(false);

  const total = $derived(quota ? (quota.limit ?? quota.usage) : 0);
  const blocks = $derived(
    (quota?.parts ?? []).map((part) => ({ ...PARTS[part.key], key: part.key, bytes: part.bytes })),
  );

  async function load() {
    loading = true;
    error = null;
    try {
      quota = await getQuota();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onchange();
      error =
        cause instanceof ApiError && cause.code === 'autorisation-incomplete'
          ? 'La lecture du quota Drive n’a pas été autorisée sur l’écran de Google. Déconnectez-vous puis reconnectez-vous en cochant toutes les autorisations.'
          : 'Google n’a pas répondu. Réessayez dans un instant.';
    } finally {
      loading = false;
    }
  }

  async function signOut() {
    await logout();
    onchange();
  }

  async function revoke() {
    await revokeAccount();
    onchange();
  }

  load();
</script>

<header class="bar">
  <h1>Gmail Drive Stat</h1>
  <span class="who">
    {#if user.picture}<img src={user.picture} alt="" referrerpolicy="no-referrer" />{/if}
    <span class="muted">{user.email}</span>
  </span>
  <button class="btn" onclick={signOut}>Se déconnecter</button>
</header>

<main>
  <section class="card">
    <div class="head">
      <div>
        <h2>Vue globale du stockage</h2>
        {#if quota}
          <p class="summary">
            <b class="mono">{formatBytes(quota.usage)}</b>
            {#if quota.limit !== null}
              utilisés sur <b class="mono">{formatBytes(quota.limit)}</b>
              <span class="muted">({formatPercent(quota.usage, quota.limit)})</span>
            {:else}
              utilisés, sans limite de quota
            {/if}
          </p>
        {/if}
      </div>
      <button class="btn" onclick={load} disabled={loading}>{loading ? 'Lecture…' : 'Actualiser'}</button>
    </div>

    {#if error}
      <div class="callout warn" role="alert">{error}</div>
    {/if}

    {#if quota}
      <QuotaTreemap {blocks} {total} />

      <table>
        <thead>
          <tr><th>Zone</th><th class="num">Taille</th><th class="num">Part du quota</th></tr>
        </thead>
        <tbody>
          {#each blocks as block (block.key)}
            <tr>
              <td>
                <span class="swatch" style:background="var({block.colorVar})"></span>
                {block.label}
                <span class="note muted">{block.note}</span>
              </td>
              <td class="num mono">{formatBytes(block.bytes)}</td>
              <td class="num mono">{formatPercent(block.bytes, total)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="muted small">
        Chiffres fournis par Google le {new Date(quota.fetchedAt).toLocaleString('fr-FR')}.
      </p>
    {:else if loading}
      <p class="muted">Lecture du quota auprès de Google…</p>
    {/if}
  </section>

  <section class="card access">
    <div>
      <h3>Accès Google</h3>
      <p class="muted">
        L'autorisation est conservée chiffrée sur ce serveur. La retirer la révoque chez Google et efface ce compte du
        serveur.
      </p>
    </div>
    {#if confirmRevoke}
      <span class="confirm">
        <button class="btn danger" onclick={revoke}>Confirmer le retrait</button>
        <button class="btn" onclick={() => (confirmRevoke = false)}>Annuler</button>
      </span>
    {:else}
      <button class="btn danger" onclick={() => (confirmRevoke = true)}>Retirer l'accès</button>
    {/if}
  </section>
</main>

<style>
  .bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 16px;
    padding: 12px 24px;
    background: var(--surface);
    border-bottom: 1px solid var(--line);
  }

  .bar h1 {
    font-size: 18px;
    flex: 1;
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

  main {
    max-width: 980px;
    margin: 0 auto;
    padding: 24px;
    display: grid;
    gap: 16px;
  }

  section {
    display: grid;
    gap: 16px;
  }

  .head,
  .access {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .access > div {
    flex: 1 1 320px;
  }

  .confirm {
    display: flex;
    gap: 8px;
  }

  h2 {
    font-size: 20px;
  }

  h3 {
    font-size: 16px;
    margin-bottom: 4px;
  }

  .summary {
    margin-top: 6px;
    font-size: 16px;
  }

  table {
    width: 100%;
    border-collapse: collapse;
  }

  th {
    text-align: left;
    font-size: 12px;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  th,
  td {
    padding: 8px 6px;
    border-bottom: 1px solid var(--fill2);
  }

  .num {
    text-align: right;
    white-space: nowrap;
  }

  .swatch {
    display: inline-block;
    width: 12px;
    height: 12px;
    border-radius: 3px;
    margin-right: 6px;
  }

  .note {
    display: block;
    font-size: 13px;
    padding-left: 22px;
  }

  .small {
    font-size: 13px;
  }
</style>

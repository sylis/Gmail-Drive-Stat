<script lang="ts">
  import { getStatus, type Status } from './lib/api';
  import Login from './Login.svelte';
  import Overview from './Overview.svelte';

  let status = $state<Status | null>(null);
  let unreachable = $state(false);

  async function refresh() {
    try {
      status = await getStatus();
      unreachable = false;
    } catch {
      unreachable = true;
    }
  }

  refresh();
</script>

{#if unreachable}
  <main class="center">
    <div class="card">
      <h2>Serveur injoignable</h2>
      <p class="muted">Le serveur Gmail Drive Stat ne répond pas. Vérifiez que le conteneur est démarré.</p>
      <button class="btn" onclick={refresh}>Réessayer</button>
    </div>
  </main>
{:else if status === null}
  <main class="center"><p class="muted">Chargement…</p></main>
{:else if status.user && !status.needsReauth}
  <Overview user={status.user} onchange={refresh} />
{:else}
  <Login {status} onrefresh={refresh} />
{/if}

<style>
  .center {
    min-height: 100vh;
    display: grid;
    place-items: center;
    padding: 24px;
  }

  .card {
    display: grid;
    gap: 12px;
    justify-items: start;
    max-width: 420px;
  }
</style>

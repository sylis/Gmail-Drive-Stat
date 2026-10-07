<script lang="ts">
  import type { Status } from './lib/api';
  import SetupGuide from './SetupGuide.svelte';

  let { status, onrefresh }: { status: Status; onrefresh: () => void } = $props();

  let showGuide = $state(false);
</script>

<main>
  <div class="card login">
    <h1>Gmail Drive Stat</h1>
    <p class="muted">
      Connectez-vous avec votre compte Google pour voir ce qui occupe votre espace de stockage. L'outil lit votre
      identité, les totaux de votre quota et les métadonnées de vos e-mails (jamais leur contenu). Rien ne quitte ce
      serveur.
    </p>

    {#if status.needsReauth}
      <div class="callout" role="status">
        Google a mis fin à votre autorisation (mode test). Reconnectez-vous : vos données sont conservées.
      </div>
    {:else if status.flash?.kind === 'refuse'}
      <div class="callout warn" role="alert">
        <b>{status.flash.email}</b> n'est pas autorisé sur ce serveur. Utilisez un autre compte, ou ajoutez cette adresse
        à <code>ALLOWED_EMAILS</code>.
      </div>
    {:else if status.flash?.kind === 'annule'}
      <div class="callout" role="status">Connexion annulée sur l'écran de Google.</div>
    {:else if status.flash?.kind === 'echec'}
      <div class="callout warn" role="alert">
        La connexion Google n'a pas abouti. Réessayez ; si le problème persiste, vérifiez l'identifiant client, son
        secret et l'adresse de retour déclarée chez Google.
      </div>
    {/if}

    {#if status.configured}
      <a class="btn primary" href="/auth/google">
        {status.needsReauth ? 'Se reconnecter avec Google' : 'Se connecter avec Google'}
      </a>
      <button class="link" onclick={() => (showGuide = !showGuide)}>
        {showGuide ? "Masquer l'aide à l'installation" : "Aide à l'installation"}
      </button>
    {:else}
      <span class="btn primary disabled" aria-disabled="true">Se connecter avec Google</span>
    {/if}
  </div>

  {#if !status.configured || showGuide}
    <SetupGuide redirectUri={status.redirectUri} configured={status.configured} oncheck={onrefresh} />
  {/if}
</main>

<style>
  main {
    min-height: 100vh;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: 16px;
    padding: 24px;
  }

  .login {
    display: grid;
    gap: 16px;
    justify-items: start;
    width: min(100%, 460px);
  }

  .disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .link {
    font: inherit;
    font-size: 13px;
    color: var(--accent);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    text-decoration: underline;
  }
</style>

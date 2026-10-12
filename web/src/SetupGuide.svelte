<script lang="ts">
  let { redirectUri, configured, oncheck }: { redirectUri: string; configured: boolean; oncheck: () => void } = $props();

  let copied = $state(false);

  async function copy() {
    await navigator.clipboard.writeText(redirectUri);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }
</script>

<section class="card">
  <header>
    <h2>Première installation : créer votre accès Google</h2>
    <span class="chip">À faire une seule fois · environ 10 min</span>
  </header>

  {#if !configured}
    <div class="callout warn" role="alert">
      Aucun identifiant Google n'est configuré sur ce serveur. Suivez ces étapes, puis redémarrez le conteneur.
    </div>
  {/if}

  <ol>
    <li>
      Ouvrez <code>console.cloud.google.com</code> avec votre compte Gmail et <b>créez un projet</b>, par exemple
      « Gmail Drive Stat ».
    </li>
    <li>Dans <b>API et services › Bibliothèque</b>, activez <b>Google Drive API</b> et <b>Gmail API</b>.</li>
    <li>
      Dans <b>Écran de consentement OAuth</b>, choisissez le type <b>Externe</b>, donnez un nom à l'application et votre
      e-mail de contact. Laissez l'application <b>en mode Test</b>.
    </li>
    <li>Dans <b>Utilisateurs test</b>, ajoutez votre adresse Gmail.</li>
    <li>
      Dans <b>Accès aux données</b>, ajoutez les champs d'application <code>https://mail.google.com/</code> et
      <code>https://www.googleapis.com/auth/drive</code> (accès complets à Gmail et à Drive, nécessaires pour supprimer).
    </li>
    <li>
      Dans <b>Identifiants › Créer des identifiants › ID client OAuth</b>, choisissez <b>Application Web</b> et collez
      cette URI de redirection :
      <span class="uri">
        <code>{redirectUri}</code>
        <button class="btn small" onclick={copy}>{copied ? 'Copié' : 'Copier'}</button>
      </span>
    </li>
    <li>
      Copiez l'<b>ID client</b> et le <b>code secret</b> dans votre fichier <code>.env</code> :
      <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, et votre adresse dans
      <code>ALLOWED_EMAILS</code>.
    </li>
    <li>Redémarrez le conteneur, puis cliquez sur <b>Vérifier la configuration</b>.</li>
  </ol>

  <footer>
    <button class="btn" onclick={oncheck}>Vérifier la configuration</button>
    <p class="muted">Les intitulés de la console Google changent souvent : le guide du dépôt fera foi.</p>
  </footer>
</section>

<style>
  section {
    display: grid;
    gap: 14px;
    width: min(100%, 720px);
  }

  header,
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px 14px;
  }

  h2 {
    font-size: 18px;
    flex: 1 1 280px;
  }

  .chip {
    font-size: 12px;
    color: var(--muted);
    background: var(--fill);
    border-radius: 999px;
    padding: 3px 10px;
  }

  ol {
    margin: 0;
    padding-left: 22px;
    display: grid;
    gap: 8px;
  }

  .uri {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
  }

  .small {
    padding: 2px 8px;
    font-size: 12px;
  }

  footer p {
    font-size: 13px;
    flex: 1 1 240px;
  }
</style>

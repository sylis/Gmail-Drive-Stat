<script lang="ts">
  import { untrack } from 'svelte';
  import { ApiError } from '../lib/api';
  import { describeScope, getMailbox, startScan, type GmailLabel, type GmailState, type ScanScope } from '../lib/gmail';

  let {
    state: gmail,
    onstarted,
    oncancel,
    onauth,
  }: { state: GmailState; onstarted: () => void; oncancel?: () => void; onauth: () => void } = $props();

  // Prérempli avec le dernier choix, comme le demande le bouton Actualiser.
  const initial = untrack(() => gmail);
  const last: ScanScope | undefined = initial.scan?.scope ?? initial.scopes[0]?.scope;
  const today = new Date().toISOString().slice(0, 10);

  let kind = $state<ScanScope['period']['kind']>(last?.period.kind ?? 'all');
  let days = $state(last?.period.kind === 'days' ? last.period.days : 90);
  let from = $state(last?.period.kind === 'range' ? last.period.from : `${new Date().getFullYear() - 5}-01-01`);
  let to = $state(last?.period.kind === 'range' ? (last.period.to ?? '') : '');
  let labelIds = $state<string[]>(last?.labelIds ?? []);
  let minSizeMb = $state(last?.minSizeMb ?? 0);
  let attachmentDetail = $state<ScanScope['attachmentDetail']>(last?.attachmentDetail ?? 'large');

  let labels = $state<GmailLabel[]>(initial.labels);
  let mailbox = $state<{ messagesTotal: number; threadsTotal: number } | null>(null);
  let showLabels = $state((last?.labelIds.length ?? 0) > 0);
  let sending = $state(false);
  let error = $state<string | null>(null);

  // Les libellés d'état (non lus, importants…) ne sont pas des rangements : inutile de les proposer.
  const HIDDEN = new Set(['UNREAD', 'STARRED', 'IMPORTANT', 'CHAT', 'DRAFT']);
  const SYSTEM: Record<string, string> = { INBOX: 'Boîte de réception', SENT: 'Envoyés', TRASH: 'Corbeille', SPAM: 'Spam' };
  const choices = $derived(
    labels
      .filter((label) => !HIDDEN.has(label.id) && !label.id.startsWith('CATEGORY_'))
      .map((label) => ({ id: label.id, name: SYSTEM[label.id] ?? label.name, system: label.type === 'system' }))
      .sort((a, b) => Number(b.system) - Number(a.system) || a.name.localeCompare(b.name, 'fr')),
  );

  const scope = $derived<ScanScope>({
    period: kind === 'all' ? { kind } : kind === 'days' ? { kind, days: Math.max(1, Math.floor(days) || 1) } : { kind, from, to: to || null },
    labelIds,
    minSizeMb,
    attachmentDetail,
  });
  const valid = $derived(kind !== 'range' || (Boolean(from) && (!to || to >= from)));

  getMailbox().then(
    (result) => {
      mailbox = result;
      labels = result.labels;
    },
    (cause) => {
      if (cause instanceof ApiError && cause.status === 401) onauth();
    },
  );

  function toggleLabel(id: string) {
    labelIds = labelIds.includes(id) ? labelIds.filter((other) => other !== id) : [...labelIds, id];
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    sending = true;
    error = null;
    try {
      await startScan(scope);
      onstarted();
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) return onauth();
      error = cause instanceof ApiError && cause.code === 'scan-deja-en-cours' ? 'Un scan est déjà en cours.' : 'Le scan n’a pas pu démarrer.';
    } finally {
      sending = false;
    }
  }
</script>

<div class="backdrop">
  <form class="modal" onsubmit={submit} aria-labelledby="scope-title">
    <header id="scope-title">Que voulez-vous analyser ?</header>
    <div class="body">
      <fieldset>
        <legend class="lbl">Période</legend>
        <label class="row"
          ><input type="radio" bind:group={kind} value="days" /> Les
          <input class="input short" type="number" min="1" max="36500" bind:value={days} onfocus={() => (kind = 'days')} aria-label="Nombre de jours" />
          derniers jours</label
        >
        <label class="row"
          ><input type="radio" bind:group={kind} value="range" /> Du
          <input class="input" type="date" max={today} bind:value={from} onfocus={() => (kind = 'range')} aria-label="Date de début" />
          au
          <input class="input" type="date" max={today} bind:value={to} onfocus={() => (kind = 'range')} aria-label="Date de fin, vide pour aujourd’hui" />
        </label>
        <label class="row"><input type="radio" bind:group={kind} value="all" /> Toute la boîte</label>
        <p class="hint">Une conversation à cheval sur la limite est lue en entier.</p>
      </fieldset>

      <fieldset>
        <legend class="lbl">Libellés</legend>
        <button type="button" class="input pick" onclick={() => (showLabels = !showLabels)} aria-expanded={showLabels}>
          {labelIds.length === 0 ? 'Tous les libellés' : `${labelIds.length} libellé${labelIds.length > 1 ? 's' : ''} choisi${labelIds.length > 1 ? 's' : ''}`}
          <span aria-hidden="true">{showLabels ? '▴' : '▾'}</span>
        </button>
        {#if showLabels}
          <div class="labels">
            {#each choices as label (label.id)}
              <label class="row"
                ><input type="checkbox" checked={labelIds.includes(label.id)} onchange={() => toggleLabel(label.id)} />
                <span class:muted={label.system}>{label.name}</span></label
              >
            {:else}
              <span class="hint">Lecture des libellés…</span>
            {/each}
          </div>
        {/if}
      </fieldset>

      <fieldset>
        <legend class="lbl">Taille minimale d'un message</legend>
        <div class="row">
          <select class="input" bind:value={minSizeMb} aria-label="Taille minimale d’un message">
            <option value={0}>Aucune</option>
            {#each [1, 2, 5, 10, 20] as size (size)}<option value={size}>{size} Mo</option>{/each}
          </select>
          <span class="hint">Commencer par les gros messages trouve vite l'essentiel de l'espace.</span>
        </div>
      </fieldset>

      <fieldset>
        <legend class="lbl">Détail des pièces jointes</legend>
        <label class="row"><input type="radio" bind:group={attachmentDetail} value="large" /> Messages de plus de 1 Mo seulement (plus rapide)</label>
        <label class="row"><input type="radio" bind:group={attachmentDetail} value="all" /> Tous les messages (plus long)</label>
      </fieldset>

      <div class="callout">
        {#if mailbox}
          Votre boîte compte <b>{mailbox.threadsTotal.toLocaleString('fr-FR')} conversations</b>
          ({mailbox.messagesTotal.toLocaleString('fr-FR')} messages).
        {/if}
        {#if gmail.summary.conversations > 0}
          Déjà en base : {gmail.summary.conversations.toLocaleString('fr-FR')} conversations{#if gmail.scopes.length > 0}
            &nbsp;({gmail.scopes
              .slice(0, 3)
              .map((entry) => describeScope(entry.scope, labels).join(', '))
              .join(' ; ')}){/if}. Seuls les nouveaux et les changements seront lus.
        {:else}
          Le scan tourne sur le serveur : vous pourrez fermer l'onglet et revenir plus tard.
        {/if}
      </div>

      {#if error}<div class="callout warn" role="alert">{error}</div>{/if}
    </div>
    <footer>
      {#if oncancel}<button type="button" class="btn ghost" onclick={oncancel}>Annuler</button>{/if}
      <button class="btn primary" disabled={!valid || sending}>Lancer le scan</button>
    </footer>
  </form>
</div>

<style>
  fieldset {
    border: 0;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 8px;
  }

  legend {
    padding: 0;
    margin-bottom: 8px;
  }

  label.row {
    flex-wrap: wrap;
    cursor: pointer;
  }

  .short {
    width: 80px;
  }

  .pick {
    display: flex;
    justify-content: space-between;
    cursor: pointer;
    text-align: left;
  }

  .labels {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: 4px 12px;
    max-height: 170px;
    overflow: auto;
    border: 1px solid var(--line);
    border-radius: 6px;
    padding: 8px 10px;
  }
</style>

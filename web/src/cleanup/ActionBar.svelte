<script lang="ts">
  import type { Snippet } from 'svelte';
  import { formatBytes } from '../lib/format';

  let {
    summary,
    size,
    empty,
    total,
    simulate = $bindable(),
    blocked,
    needsAccess,
    serviceName,
    sorting,
    onselectall,
    onclear,
    onaction,
    onjournal,
  }: {
    /** « 3 conversations », « 1 fichier ». */
    summary: string;
    size: number;
    empty: boolean;
    /** Nombre d'éléments que « Tout sélectionner » prendrait (ceux de la vue filtrée). */
    total: number;
    simulate: boolean;
    /** Raison pour laquelle aucune action n'est possible pour l'instant ; null sinon. */
    blocked: string | null;
    /** L'accès en écriture n'a pas été accordé : seules les simulations sont possibles. */
    needsAccess: boolean;
    serviceName: string;
    /** Actions de tri (archiver, lu, non lu), propres au service ; elles ne libèrent pas de place. */
    sorting?: Snippet<[boolean]>;
    onselectall: () => void;
    onclear: () => void;
    onaction: (action: 'trash' | 'delete') => void;
    onjournal: () => void;
  } = $props();

  const disabled = $derived(empty || blocked !== null || (needsAccess && !simulate));
</script>

<div class="actionbar">
  <b>Sélection : {empty ? 'aucune' : `${summary} · ${formatBytes(size)}`}</b>
  <button class="btn small ghost" onclick={onselectall} disabled={total === 0}>Tout sélectionner ({total.toLocaleString('fr-FR')})</button>
  <button class="btn small ghost" onclick={onclear} disabled={empty}>Vider la sélection</button>
  <span class="grow"></span>
  {#if blocked}
    <span class="hint">{blocked}</span>
  {:else if needsAccess}
    <span class="hint">
      Pour agir, autorisez l'accès complet à {serviceName} : <a href="/auth/google?consent=1">Autoriser avec Google</a>. En attendant, seule la
      simulation est possible.
    </span>
  {/if}
  <label class="row sim" title="Déroule l'action sans rien envoyer à Google ni rien modifier ; le résultat est noté dans le journal.">
    <input type="checkbox" bind:checked={simulate} /> Simulation
  </label>
  <button class="btn small ghost" onclick={onjournal}>Journal</button>
  <span class="sep"></span>
  {@render sorting?.(disabled)}
  {#if sorting}<span class="sep"></span>{/if}
  <button class="btn small danger" {disabled} onclick={() => onaction('trash')}>Corbeille</button>
  <button class="btn small danger solid" {disabled} onclick={() => onaction('delete')}>Supprimer définitivement</button>
</div>

<style>
  .actionbar {
    position: sticky;
    bottom: 0;
    z-index: 5;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    border-top: 1px solid var(--line);
    background: var(--fill);
    font-size: 13.5px;
  }

  .sep {
    width: 1px;
    height: 22px;
    background: var(--line);
  }

  .sim {
    gap: 5px;
    cursor: pointer;
  }

  .hint {
    max-width: 420px;
  }

  .actionbar :global(.btn:disabled) {
    opacity: 0.4;
    cursor: not-allowed;
  }
</style>

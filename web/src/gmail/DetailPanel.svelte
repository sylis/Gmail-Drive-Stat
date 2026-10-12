<script lang="ts">
  import type { Snippet } from 'svelte';
  import { formatBytes } from '../lib/format';
  import { ATT_TYPES, gmailLink, ZONE_LABELS, type Conversation } from '../lib/gmail';

  let {
    conversation,
    block,
    email,
    onzoom,
    actions,
    blockActions,
  }: {
    conversation: Conversation | null;
    /** Bloc du treemap qui contient la brique : son nom, ses totaux et son chemin. */
    block: { name: string; v: number; c: number } | null;
    email: string;
    onzoom: () => void;
    actions?: Snippet;
    blockActions?: Snippet;
  } = $props();
</script>

<aside class="detail">
  <span class="lbl">Conversation</span>
  {#if conversation}
    <h3>{conversation.subject || '(sans objet)'}</h3>
    <dl>
      <dt>Zone</dt><dd>{ZONE_LABELS[conversation.zone]}</dd>
      <dt>Domaine</dt><dd>{conversation.domain || '—'}</dd>
      <dt>Expéditeur</dt><dd>{conversation.sender || '—'}</dd>
      <dt>Dernier msg</dt><dd class="mono">{new Date(conversation.date).toLocaleDateString('fr-FR')}</dd>
      <dt>Messages</dt><dd class="mono">{conversation.msgs}</dd>
      <dt>Taille</dt><dd class="mono"><b>{formatBytes(conversation.size)}</b></dd>
      <dt>Libellé</dt><dd>{conversation.label || 'Sans libellé'}</dd>
      {#if conversation.category}<dt>Catégorie</dt><dd>{conversation.category}</dd>{/if}
      {#if conversation.list}<dt>Liste</dt><dd>{conversation.list}</dd>{/if}
    </dl>

    {#if conversation.flagged}
      <div class="callout">Contient un message marqué important ou suivi.</div>
    {/if}

    <div class="col atts">
      <span class="lbl">Pièces jointes</span>
      {#each conversation.attachments.slice(0, 12) as attachment, index (index)}
        <div class="att">
          <i class="sw" style:background="var({ATT_TYPES[attachment.type]?.color ?? '--t-oth'})"></i>
          <span class="name" title={attachment.name}>{attachment.name}</span>
          <span class="mono muted">{formatBytes(attachment.size)}</span>
        </div>
      {:else}
        <span class="hint">
          {conversation.messages.some((message) => message.attCount === null) ? 'Non lues par le scan (messages de moins de 1 Mo).' : 'Aucune · brique grise'}
        </span>
      {/each}
      {#if conversation.attachments.length > 12}<span class="hint">… et {conversation.attachments.length - 12} autres</span>{/if}
    </div>

    {#each conversation.otherZones as other (other.zone)}
      <span class="hint">
        Aussi {other.msgs} message{other.msgs > 1 ? 's' : ''} dans la zone {ZONE_LABELS[other.zone]} ({formatBytes(other.size)}).
      </span>
    {/each}

    {@render actions?.()}
    <a class="btn small ghost" href={gmailLink(email, conversation.id)} target="_blank" rel="noopener noreferrer">Ouvrir dans Gmail ↗</a>

    {#if block}
      <div class="block col">
        <span class="lbl">Bloc parent</span>
        <b>{block.name}</b>
        <span class="muted mono">{block.c.toLocaleString('fr-FR')} conversations · {formatBytes(block.v)}</span>
        <button class="btn small" onclick={onzoom}>Zoomer sur le bloc</button>
        {@render blockActions?.()}
      </div>
    {/if}
  {:else}
    <p class="hint">Cliquez sur une brique du treemap ou une ligne de la liste pour voir la conversation et ses e-mails.</p>
  {/if}
</aside>

<style>
  .detail {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 12px;
    min-width: 0;
  }

  h3 {
    font-size: 15px;
    overflow-wrap: anywhere;
  }

  dl {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 4px 8px;
    margin: 0;
    font-size: 13px;
  }

  dt {
    color: var(--muted);
  }

  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .atts {
    gap: 5px;
  }

  .att {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 12.5px;
  }

  .att .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .callout {
    font-size: 13px;
  }

  .btn {
    align-self: flex-start;
  }

  .block {
    margin-top: auto;
    gap: 6px;
    border: 1px solid var(--line);
    border-radius: 8px;
    padding: 10px;
    font-size: 13px;
  }
</style>

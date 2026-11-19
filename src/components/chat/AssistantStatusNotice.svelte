<script lang="ts">
import Button from "../ui/Button.svelte";
import Icon from "../ui/Icon.svelte";

/**
 * How a turn that produced no answer ends: the run failed, or the user stopped it.
 *
 * Both used to be rendered as Obsidian callouts through the markdown renderer, which
 * put a full-width tinted banner (in whatever the theme makes of a callout) into a
 * chat that is otherwise chromeless. These match the rest of the timeline instead:
 * the error is a quiet card in the tool-output surface colour with its Retry inline,
 * and a stop is a single faint line, like a tool row.
 */
interface Props {
	kind: "error" | "cancelled";
	/** Raw failure message from the provider/transport, shown verbatim. */
	detail?: string;
	onRetry?: () => void;
}

const { kind, detail = undefined, onRetry = undefined }: Props = $props();

const trimmedDetail = $derived(detail?.trim() || "The model request failed.");
</script>

{#if kind === "error"}
  <div class="s2b-turn-error" role="alert">
    <div class="turn-error-header">
      <span class="turn-error-icon"><Icon name="triangle-alert" size="s" /></span>
      <span class="turn-error-title">Something went wrong</span>
      {#if onRetry}
        <Button
          class="clickable-icon turn-error-retry"
          iconId="refresh-cw"
          buttonText="Retry"
          ariaLabel="Retry this request"
          tooltip="Re-run the failed request"
          onClick={onRetry}
        />
      {/if}
    </div>
    <div class="turn-error-detail">{trimmedDetail}</div>
  </div>
{:else}
  <div class="s2b-turn-stopped">
    <Icon name="circle-stop" size="xs" />
    <span>Stopped</span>
  </div>
{/if}

<style>
  .s2b-turn-error {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 8px 8px 10px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    /* Same surface as the tool-output blocks in ToolCallsSection. */
    background: color-mix(in srgb, var(--background-secondary) 40%, transparent);
  }

  .turn-error-header {
    display: flex;
    align-items: center;
    gap: 8px;
    /* Keeps the row height stable whether or not Retry is rendered. */
    min-height: 28px;
  }

  /* The only red in the notice: enough to say "error" without tinting the block. */
  .turn-error-icon {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--text-error);
  }

  .turn-error-title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--font-ui-small);
    font-weight: var(--font-medium);
    color: var(--text-normal);
  }

  .s2b-turn-error :global(.turn-error-retry) {
    flex-shrink: 0;
    gap: 6px;
    font-size: var(--font-ui-small);
    color: var(--text-muted);
  }

  /* Provider messages are arbitrary: raw JSON, stack-ish text, a single very long
     URL. Keep them verbatim and selectable, but wrapped and height-capped so one
     failure can't take over the chat. Indented to line up under the title. */
  .turn-error-detail {
    padding-left: calc(var(--icon-s) + 8px);
    padding-right: 4px;
    max-height: 9.5em;
    overflow-y: auto;
    font-size: var(--font-ui-smaller);
    line-height: 1.5;
    color: var(--text-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .s2b-turn-stopped {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 0.82rem;
    font-weight: 500;
    color: var(--text-faint);
  }
</style>

<script lang="ts">
import type { SessionRegistry } from "../../stores/chatStore.svelte";
import { icon } from "../../utils/utils";
import { getVoiceSession } from "../../voice/voiceSession.svelte";
import MessageContainer from "./MessageContainer.svelte";
import VoiceOrb from "./VoiceOrb.svelte";

/**
 * What the chat view shows while voice mode is bound to its thread: the orb, a
 * status line, the last couple of transcript lines, and stop / show-chat controls.
 * "Show chat" shrinks the orb into a header strip and renders the message list
 * beneath it so delegated turns and their tool cards can be watched; the composer
 * stays hidden because voice is the input.
 */
interface Props {
	registry: SessionRegistry;
	threadPath: string | null;
}

const { registry, threadPath }: Props = $props();

const voice = getVoiceSession();

let showChat = $state(false);

const label = $derived.by(() => {
	switch (voice.status) {
		case "connecting":
			return "Connecting…";
		case "listening":
			return "Listening";
		case "speaking":
			return "Speaking";
		case "agentWorking":
			return "Thinking…";
		case "error":
			return voice.errorMessage ?? "Voice mode stopped";
		default:
			return "";
	}
});

const recentLines = $derived.by(() => {
	const lines = voice.transcript.slice(-2);
	if (voice.liveAssistantText) {
		return [...lines, { role: "assistant" as const, text: voice.liveAssistantText }].slice(-2);
	}
	return lines;
});

const level = () => voice.level();
</script>

<div class="s2b-voice-surface" class:is-split={showChat} data-testid="voice-surface">
  <div class="s2b-voice-stage">
    <VoiceOrb status={voice.status} {level} compact={showChat} />
    <div class="s2b-voice-label" class:is-error={voice.status === "error"}>{label}</div>
    {#if !showChat}
      <div class="s2b-voice-lines">
        {#each recentLines as line, i (`${i}:${line.text}`)}
          <div class="s2b-voice-line" data-role={line.role}>
            <span class="s2b-voice-line-role">{line.role === "user" ? "You" : "Assistant"}</span>
            {line.text}
          </div>
        {/each}
      </div>
    {/if}
    <div class="s2b-voice-actions">
      <button
        type="button"
        class="clickable-icon"
        aria-label={showChat ? "Hide chat" : "Show chat"}
        use:icon={"messages-square"}
        onclick={() => (showChat = !showChat)}
      ></button>
      <button
        type="button"
        class="clickable-icon s2b-voice-stop"
        aria-label="Stop voice mode"
        use:icon={"square"}
        onclick={() => voice.stop()}
      ></button>
    </div>
  </div>
  {#if showChat}
    <MessageContainer {registry} {threadPath} />
  {/if}
</div>

<style>
  .s2b-voice-surface {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .s2b-voice-stage {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--size-4-4);
    padding: var(--size-4-6);
    min-height: 0;
  }

  .s2b-voice-surface.is-split .s2b-voice-stage {
    flex: 0 0 auto;
    flex-direction: row;
    justify-content: flex-start;
    gap: var(--size-4-3);
    padding: var(--size-4-2) var(--size-4-3);
    border-bottom: 1px solid var(--background-modifier-border);
  }

  .s2b-voice-label {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    text-align: center;
  }

  .s2b-voice-surface.is-split .s2b-voice-label {
    flex: 1 1 auto;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .s2b-voice-label.is-error {
    color: var(--text-error);
  }

  .s2b-voice-lines {
    display: flex;
    flex-direction: column;
    gap: var(--size-2-2);
    width: min(100%, 36rem);
    min-height: 3.2em;
  }

  .s2b-voice-line {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
    text-align: center;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .s2b-voice-line[data-role="assistant"] {
    color: var(--text-normal);
  }

  .s2b-voice-line-role {
    color: var(--text-faint);
    margin-right: var(--size-2-2);
  }

  .s2b-voice-actions {
    display: flex;
    gap: var(--size-2-3);
  }

  .s2b-voice-stop {
    color: var(--text-error);
  }
</style>

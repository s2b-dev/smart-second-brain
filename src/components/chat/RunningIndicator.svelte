<script lang="ts">
import { getSessionRegistry } from "../../stores/chatStore.svelte";
import { getData } from "../../stores/dataStore.svelte";
import { getPlugin } from "../../stores/state.svelte";
import { icon } from "../../utils/utils";
import { t } from "../../i18n";

const registry = $derived(getSessionRegistry());
const pluginData = getData();

// All chats currently streaming. Concurrency-ready: one chip per running
// session. Under the Phase-1 one-at-a-time policy there is at most one.
// Suppressed entirely when the status-bar indicator is disabled in settings.
const running = $derived(
	pluginData.showActiveAgentsInStatusBar
		? (registry?.runningSessions ?? []).map((s) => ({
				path: s.id,
				name:
					s.id
						.split("/")
						.pop()
						?.replace(/\.chat$/, "") ?? s.id,
			}))
		: [],
);

function openChat(path: string) {
	void getPlugin().agentManager.openChatByThreadId(path);
}
</script>

{#each running as chat (chat.path)}
	<div class="s2b-running-indicator">
		<button
			type="button"
			class="s2b-running-go"
			onclick={() => openChat(chat.path)}
			title={t("chat.running.go_to", { name: chat.name })}
		>
			<span class="s2b-running-spinner" use:icon={"loader-circle"}></span>
			<span class="s2b-running-label">{chat.name}</span>
		</button>
	</div>
{/each}

<style>
	.s2b-running-indicator {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		height: 100%;
		line-height: 1;
	}

	.s2b-running-go {
		display: inline-flex;
		align-items: center;
		height: auto;
		min-height: 0;
		padding: 0;
		margin: 0;
		background: transparent;
		border: none;
		box-shadow: none;
		border-radius: 0;
		font-size: inherit;
		line-height: 1;
		cursor: pointer;
		color: var(--text-muted);
		gap: var(--size-2-2);
		max-width: 220px;
	}

	.s2b-running-go:hover {
		color: var(--text-normal);
	}

	.s2b-running-label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	/* Center the injected SVG so rotation pivots on its true center.
	   Size to ~1em so the icon never grows the fixed-height status bar. */
	.s2b-running-spinner {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		flex: 0 0 auto;
		width: 1em;
		height: 1em;
	}

	.s2b-running-spinner :global(svg) {
		width: 1em;
		height: 1em;
		display: block;
	}

	.s2b-running-spinner {
		animation: s2b-spin 1.2s linear infinite;
		transform-origin: center;
	}

	@keyframes s2b-spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>

<script lang="ts">
import { Component } from "obsidian";
import { getPlugin } from "../../stores/state.svelte";
import { WidgetRenderChild } from "../../widget/WidgetRenderChild";
import { parseWidgetSpec } from "../../widget/widgetSpec";

/**
 * A proposed `.widget` file, rendered as the widget it would be — the review
 * surface for a staged create/update/delete of one. The renderer never reads
 * disk, so the staged content mounts exactly like a saved file would, queries
 * and all; what the user approves is what they see.
 *
 * Mounted lazily by the pending-changes bar (only while the row is expanded):
 * each preview is a full sandboxed frame, so a chat with several pending
 * widgets must not spin them all up at once.
 */
interface Props {
	/** The staged file content: frontmatter, then HTML. */
	content: string;
	/** The widget's vault path, which its note links resolve against. */
	sourcePath: string;
}

const { content, sourcePath }: Props = $props();
let container: HTMLElement | undefined = $state();

$effect(() => {
	if (!container) return;
	const host = container;
	// Re-mounts on every content change (a group reject rewrites the proposal).
	const spec = parseWidgetSpec(content);
	const component = new Component();
	component.load();
	component.addChild(new WidgetRenderChild(host, getPlugin().app, spec, sourcePath));
	return () => {
		component.unload();
		host.empty();
	};
});
</script>

<div class="s2b-widget-review-preview" bind:this={container}></div>

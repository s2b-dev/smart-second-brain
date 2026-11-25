<script lang="ts">
import GenericAIIcon from "./GenericAIIcon.svelte";

interface Props {
	/** Sanitized SVG markup from the provider directory snapshot. */
	svg?: string;
	width?: number;
	height?: number;
	class?: string;
}

let { svg, width = 16, height = 16, class: className = "" }: Props = $props();

// Drawn as a CSS mask over `currentColor`, never inserted as markup: the shape follows the
// theme like the built-in logos do, and a mask image can't run script whatever the file holds.
const maskUrl = $derived(svg ? `url("data:image/svg+xml,${encodeURIComponent(svg)}")` : undefined);
</script>

{#if maskUrl}
	<span
		class="s2b-directory-logo {className}"
		style:width="{width}px"
		style:height="{height}px"
		style:mask-image={maskUrl}
		style:-webkit-mask-image={maskUrl}
		aria-hidden="true"
	></span>
{:else}
	<GenericAIIcon {width} {height} class={className} />
{/if}

<style>
	.s2b-directory-logo {
		display: inline-block;
		flex: none;
		background-color: currentColor;
		mask-repeat: no-repeat;
		mask-position: center;
		mask-size: contain;
		-webkit-mask-repeat: no-repeat;
		-webkit-mask-position: center;
		-webkit-mask-size: contain;
	}
</style>

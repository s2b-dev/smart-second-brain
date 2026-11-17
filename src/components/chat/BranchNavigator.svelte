<script lang="ts">
import type { BranchInfo } from "../../stores/chatTimeline";
import { icon } from "../../utils/utils";

interface Props {
	/** Branch information for navigation */
	branchInfo: BranchInfo;
	/** Called when user navigates to a different branch */
	onNavigate: (checkpointId: string) => void;
}

const { branchInfo, onNavigate }: Props = $props();

const canGoLeft = $derived(branchInfo.currentIndex > 1);
const canGoRight = $derived(branchInfo.currentIndex < branchInfo.totalBranches);

function navigateLeft() {
	if (!canGoLeft) return;
	const prevCheckpointId = branchInfo.siblingCheckpointIds[branchInfo.currentIndex - 2];
	if (prevCheckpointId) {
		onNavigate(prevCheckpointId);
	}
}

function navigateRight() {
	if (!canGoRight) return;
	const nextCheckpointId = branchInfo.siblingCheckpointIds[branchInfo.currentIndex];
	if (nextCheckpointId) {
		onNavigate(nextCheckpointId);
	}
}
</script>

{#if branchInfo.totalBranches > 1}
	<div class="branch-nav s2b-flex s2b-items-center s2b-gap-1 s2b-text-xs s2b-text-text-muted s2b-select-none">
		<button
			class="clickable-icon branch-nav-btn"
			disabled={!canGoLeft}
			onclick={navigateLeft}
			aria-label="Previous branch"
			title="Previous branch"
		>
			<div
				class="s2b-w-3 s2b-h-3"
				use:icon={"chevron-left"}
				style="--icon-size: 12px"
			></div>
		</button>
		<span class="s2b-font-medium s2b-tabular-nums">
			{branchInfo.currentIndex} / {branchInfo.totalBranches}
		</span>
		<button
			class="clickable-icon branch-nav-btn"
			disabled={!canGoRight}
			onclick={navigateRight}
			aria-label="Next branch"
			title="Next branch"
		>
			<div
				class="s2b-w-3 s2b-h-3"
				use:icon={"chevron-right"}
				style="--icon-size: 12px"
			></div>
		</button>
	</div>
{/if}

<style>
	/* Rely on Obsidian's native .clickable-icon for the resting/hover look
	   (transparent → --background-modifier-hover, rounded, native cursor). Only
	   tighten the padding so the chevrons sit snug around the branch counter. */
	.branch-nav-btn {
		padding: 3px;
	}

	.branch-nav-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
</style>

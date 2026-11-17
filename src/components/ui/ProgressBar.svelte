<script lang="ts">
import { chatLayout } from "../../stores/state.svelte";

interface Props {
	progress?: number; // Progress value from 0 to 100
}

let { progress = 0 }: Props = $props();
</script>

<progress
    style="--dynamic-color: {chatLayout.isSidebar
        ? 'var(--background-secondary-alt)'
        : 'var(--background-primary-alt)'};"
    class="s2b-my-2 s2b-h-2 s2b-w-full s2b-rounded-lg s2b-border s2b-border-solid s2b-border-[--background-modifier-border] s2b-appearance-none [&::-webkit-progress-bar]:s2b-bg-[--dynamic-color] [&::-webkit-progress-bar]:s2b-shadow-[0px_0px_0px_0.3px_var(--background-modifier-form-field)_inset] [&::-webkit-progress-bar]:s2b-rounded-lg [&::-webkit-progress-bar]:s2b-overflow-hidden [&::-webkit-progress-value]:s2b-rounded-lg [&::-webkit-progress-value]:s2b-bg-[--color-accent] [&::-moz-progress-bar]:s2b-bg-[--dynamic-color] [&::-moz-progress-bar]:s2b-shadow-[0px_0px_0px_0.3px_var(--background-modifier-form-field)_inset] [&::-moz-progress-bar]:s2b-rounded-none [&::-moz-progress-bar]:s2b-overflow-hidden"
    value={progress}
    max="100"
></progress>

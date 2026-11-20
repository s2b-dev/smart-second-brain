<script lang="ts">
import { SearchComponent } from "obsidian";
import { onMount } from "svelte";
import { t } from "../../i18n";
import { getPlugin } from "../../stores/state.svelte";

interface Props {
	value?: string;
	placeholder?: string;
	disabled?: boolean;
	class?: string;
	onchange?: (value: string) => void;
}

let {
	value = $bindable(""),
	placeholder = t("ui.search.placeholder"),
	disabled = false,
	class: className = "",
	onchange,
}: Props = $props();

const plugin = getPlugin();
let containerEl: HTMLElement;
let searchComponent: SearchComponent | null = null;

onMount(() => {
	searchComponent = new SearchComponent(containerEl);
	searchComponent.setPlaceholder(placeholder);
	searchComponent.setValue(value);
	searchComponent.onChange((v) => {
		value = v;
		onchange?.(v);
	});

	if (disabled) {
		searchComponent.setDisabled(true);
	}

	return () => {
		containerEl.empty();
	};
});

// Sync external value changes
$effect(() => {
	if (searchComponent && searchComponent.getValue() !== value) {
		searchComponent.setValue(value);
	}
});

// Sync disabled state
$effect(() => {
	if (searchComponent) {
		searchComponent.setDisabled(disabled);
	}
});
</script>

<div bind:this={containerEl} class="search-wrapper {className}"></div>

<script lang="ts">
interface Props {
	checked?: boolean;
	disabled?: boolean;
	onchange?: (checked: boolean) => void;
}

let { checked = $bindable(false), disabled = false, onchange }: Props = $props();

function handleChange() {
	// The `disabled` attribute on the inner input stops the input's own
	// activation, but the click still lands on the <label> wrapper — which is
	// what actually drives this component — so the guard has to live here too.
	if (disabled) return;
	const newValue = !checked;
	checked = newValue;
	onchange?.(newValue);
}

function handleKeydown(e: KeyboardEvent) {
	if (disabled) return;
	if (e.key === "Enter" || e.key === " ") {
		e.preventDefault();
		handleChange();
	}
}
</script>

<!--
  Obsidian's native toggle structure:
  <label class="checkbox-container is-enabled">
    <input type="checkbox">
  </label>
  The ::before pseudo-element on .checkbox-container creates the toggle knob.
-->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<label
	class="checkbox-container"
	class:is-enabled={checked}
	class:s2b-toggle-disabled={disabled}
	aria-disabled={disabled}
	tabindex={disabled ? -1 : 0}
	onkeydown={handleKeydown}
>
	<input type="checkbox" tabindex={-1} {checked} {disabled} onchange={handleChange} />
</label>

<!--
  Geometry is deliberately unstyled: core sizes `.checkbox-container` from the
  `--toggle-s-*` set (`width: var(--toggle-s-width)`, height derived from
  `--toggle-s-thumb-height`) and already sets `flex-shrink: 0` itself. Overriding
  only the width — e.g. with the larger `--toggle-width` — stretches the track
  while the knob and height stay on the small-variant values, which is what
  turns the switch into a flat lozenge. Let core own the geometry.

  The disabled state is the one exception. Core has no disabled variant of
  `.checkbox-container` at all (its own ToggleComponent dims the whole
  `.setting-item` instead), so a toggle disabled on its own would otherwise look
  identical to a live one. `:global` because the element carrying the class is a
  core-structured label, and the pair of selectors is to beat core's own
  `.checkbox-container:hover` box-shadow, which sits inside a
  `@media (hover: hover)` block and would keep reacting to the pointer.
-->
<style>
:global(.checkbox-container.s2b-toggle-disabled) {
	opacity: 0.5;
	cursor: not-allowed;
}

:global(.checkbox-container.s2b-toggle-disabled:hover) {
	box-shadow: inset 0 4px 10px rgba(0, 0, 0, 0.07), inset 0 0 1px rgba(0, 0, 0, 0.21);
}
</style>

<script lang="ts">
import { icon as iconDirective } from "../../utils/utils";

type IconSize = "xs" | "s" | "m" | "l" | "xl";

interface Props {
	name: string;
	size?: IconSize | string;
	class?: string;
}

const { name, size = "s", class: className = "" }: Props = $props();

// Map named sizes to CSS variables, or use the value directly if it's a custom size
const sizeMap: Record<IconSize, string> = {
	xs: "var(--icon-xs)",
	s: "var(--icon-s)",
	m: "var(--icon-m)",
	l: "var(--icon-l)",
	xl: "var(--icon-xl)",
};

const sizeVar = $derived(sizeMap[size as IconSize] ?? size);
</script>

<div
  use:iconDirective={name}
  class="icon s2b-flex s2b-items-center s2b-justify-center {className}"
  style:--icon-size={sizeVar}
  style:width={sizeVar}
  style:height={sizeVar}
  style:font-size={sizeVar}
  aria-hidden="true"
></div>

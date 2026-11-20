<script lang="ts">
import { DOCS, type DocKey } from "../../utils/docs";
import { t } from "../../i18n";
import { icon } from "../../utils/utils";
import ExternalLinkButton from "./ExternalLinkButton.svelte";

interface Props {
	/** Which documentation page to open. */
	doc: DocKey;
	/**
	 * `icon` sits beside a setting's name (via SettingItem's `nameSuffix`); `inline`
	 * appends a text link to a section's description paragraph; `button` fills a
	 * setting row's control slot and looks like any other button there.
	 *
	 * All three render an anchor, never a `<button>` calling `window.open` — that
	 * returns null in Obsidian's iOS WKWebView and the click silently does nothing.
	 * `button` delegates to `ExternalLinkButton`, which carries the full rationale.
	 */
	variant?: "icon" | "inline" | "button";
	/** Link text for the `inline` and `button` variants. */
	label?: string;
	/**
	 * What the page explains, e.g. "Note access policy". Used to build an accessible
	 * name — an icon whose only label is "help" tells a screen-reader user nothing
	 * about where it goes.
	 */
	subject?: string;
	class?: string;
}

let { doc, variant = "icon", label = t("common.learn_more"), subject, class: className = "" }: Props = $props();

const accessibleName = $derived(subject ? t("ui.docs_link.subject_label", { subject }) : t("ui.docs_link.open_label"));
</script>

{#if variant === "icon"}
  <a
    class="s2b-docs-link-icon clickable-icon {className}"
    href={DOCS[doc]}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={accessibleName}
    title={accessibleName}
  >
    <span class="s2b-docs-link-glyph" use:icon={"help-circle"} aria-hidden="true"></span>
  </a>
{:else if variant === "button"}
  <ExternalLinkButton href={DOCS[doc]} {label} class={className} />
{:else}
  <a
    class="s2b-docs-link-inline {className}"
    href={DOCS[doc]}
    target="_blank"
    rel="noopener noreferrer"
  >
    {label} →
  </a>
{/if}

<style>
  /* `.clickable-icon` already supplies the transparent-at-rest → hover-highlight
     treatment, rounding and cursor; it is sized for a button, so pull it in to sit
     next to a setting name without inflating the row. */
  .s2b-docs-link-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 2px;
    color: var(--text-muted);
    text-decoration: none;
  }

  .s2b-docs-link-icon:hover {
    color: var(--text-normal);
  }

  /* Obsidian's `.svg-icon` reads `--icon-size` for BOTH axes. Setting only
     width/height on the wrapper leaves the injected svg at its inherited 18px, so
     it overflows the box and reads as bad centering rather than as overflow. */
  .s2b-docs-link-glyph {
    --icon-size: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
  }

  .s2b-docs-link-inline {
    font-size: var(--font-smaller);
    white-space: nowrap;
  }

</style>

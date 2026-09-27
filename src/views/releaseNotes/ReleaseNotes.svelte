<script lang="ts">
// Inlined at build time (?raw), like the onboarding wordmark; its fixed fill is
// overridden to currentColor below so it follows the theme.
import logoSvg from "../../../assets/logo-light.svg?raw";
import { RELEASES_URL, type ReleaseNotesSection, linkifyReferences } from "../../utils/releaseNotes";

let {
	sections,
	expanded,
	renderMarkdown,
}: {
	sections: ReleaseNotesSection[];
	/** How many sections start expanded; the latest is always shown in full. */
	expanded: number;
	renderMarkdown: (markdown: string, el: HTMLElement) => void;
} = $props();

const latest = $derived(sections[0]);
const earlier = $derived(sections.slice(1));

function markdown(el: HTMLElement, body: string) {
	renderMarkdown(linkifyReferences(body), el);
}

function formatDate(date: string): string {
	return new Date(`${date}T00:00:00`).toLocaleDateString(undefined, {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}
</script>

<div class="s2b-release-notes">
  <div class="s2b-release-notes-logo" role="presentation">{@html logoSvg}</div>
  {#if latest}
    <h1 class="s2b-release-notes-title">What's new in {latest.version}</h1>
    {#if latest.date}
      <p class="s2b-release-notes-date">Released on {formatDate(latest.date)}</p>
    {/if}
    <div class="markdown-rendered" use:markdown={latest.body}></div>
  {/if}

  {#if earlier.length > 0}
    <h2 class="s2b-release-notes-earlier">Earlier releases</h2>
    {#each earlier as section, index (section.version)}
      <details class="s2b-release-notes-section" open={index + 1 < expanded}>
        <summary>
          <span class="s2b-release-notes-version">{section.version}</span>
          {#if section.date}
            <span class="s2b-release-notes-section-date">{formatDate(section.date)}</span>
          {/if}
        </summary>
        <div class="markdown-rendered" use:markdown={section.body}></div>
      </details>
    {/each}
  {/if}

  <p class="s2b-release-notes-footer"><a href={RELEASES_URL}>All releases on GitHub</a></p>
</div>

<style>
  .s2b-release-notes {
    max-width: var(--file-line-width);
    margin: 0 auto;
    padding: var(--size-4-8) var(--size-4-4);
    user-select: text;
  }

  .s2b-release-notes-logo {
    color: var(--text-normal);
    margin-bottom: var(--size-4-6);
  }

  .s2b-release-notes-logo :global(svg) {
    display: block;
    width: 80px;
    height: auto;
  }

  .s2b-release-notes-logo :global(svg path) {
    fill: currentColor;
  }

  .s2b-release-notes-title {
    margin: 0;
  }

  .s2b-release-notes-date,
  .s2b-release-notes-section-date {
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .s2b-release-notes-date {
    margin: var(--size-4-2) 0 var(--size-4-6);
  }

  .s2b-release-notes-earlier {
    margin-top: var(--size-4-12);
  }

  .s2b-release-notes-section {
    border-bottom: 1px solid var(--background-modifier-border);
    padding: var(--size-4-2) 0;
  }

  /* Stays display: list-item — a flex summary loses its disclosure triangle. */
  .s2b-release-notes-section > summary {
    cursor: var(--cursor);
  }

  .s2b-release-notes-section-date {
    margin-left: var(--size-4-3);
  }

  .s2b-release-notes-version {
    font-size: var(--h3-size);
    font-weight: var(--h3-weight);
    color: var(--h3-color);
  }

  .s2b-release-notes-footer {
    margin-top: var(--size-4-6);
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }
</style>

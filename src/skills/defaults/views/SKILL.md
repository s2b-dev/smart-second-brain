---
name: views
description: Build interactive views — dashboards, charts, plots, tables, trackers — as self-contained HTML that renders live in the chat and can be saved to the vault as a note. Use when the user asks to visualize, plot, chart, or build an overview or dashboard from vault data, or wants a small interactive widget. Load this for the view block format and its data bridge.
metadata:
  author: "S2B"
  version: "1.0"
  category: "core"
---

## What a view is
A view is a `s2b-view` code fence written directly in your reply. Its body is an HTML
fragment — markup, `<style>`, `<script>` — rendered in a sandboxed frame right where you
wrote it. An optional frontmatter block at the top declares a title, a fixed height, and
named Dataview queries that the host runs for you and keeps live as the vault changes.

The user keeps a view from the toolbar above it: copy it as a block to paste into any
note, or save it as its own note. Do not create that note yourself unless asked; if the
user does ask, stage it with `manage_notes` and put the same fence in the note body.

## Format
````markdown
```s2b-view
---
title: Recently modified notes
queries:
  recent: TABLE file.mtime AS modified FROM "" SORT file.mtime DESC LIMIT 10
---
<style>
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--background-modifier-border); }
  th { color: var(--text-muted); font-weight: 500; }
</style>
<table><thead><tr><th>Note</th><th>Modified</th></tr></thead><tbody id="rows"></tbody></table>
<script>
  s2b.onData(({ recent }) => {
    const tbody = document.getElementById("rows");
    tbody.replaceChildren();
    if (recent.error) { tbody.textContent = recent.error; return; }
    for (const [link, modified] of recent.rows) {
      const row = tbody.insertRow();
      const a = document.createElement("a");
      a.textContent = link.display;
      a.onclick = () => s2b.openNote(link.path);
      row.insertCell().append(a);
      row.insertCell().textContent = new Date(modified).toLocaleDateString();
    }
  });
</script>
```
````

Frontmatter keys (all optional): `title` (toolbar label and note name when saved),
`height` (frame height in px; omit to size to content), `queries` (name → Dataview DQL
string; use `|` for a multi-line query). Body-only views with no frontmatter are fine
for static content.

## Data
- Each query is Dataview DQL (`TABLE`, `LIST`, `TASK`). Results arrive keyed by name:
  - `TABLE` → `{ type: "table", headers: string[], rows: unknown[][] }`. Rows are in
    header order; the first column is the note link unless `WITHOUT ID`.
  - `LIST` → `{ type: "list", items: unknown[] }`; `TASK` → `{ type: "task", items }`.
  - A failed query → `{ error: string }`. Always handle this branch visibly.
- Links are `{ path, display, subpath }`; dates and durations are ISO strings.
- Queries need the Dataview plugin. Without it every query yields `{ error }`, so if the
  user has no Dataview, say so and fall back to data you gather with your other tools
  and inline as a JSON constant.
- Prefer queries over inlined data whenever the data lives in the vault: queries stay
  live after the view is saved, a constant goes stale. Inline data only for things that
  are not in the vault (a formula to plot, a worked example).

## Runtime API (inside the frame)
- `s2b.onData(callback)` — receives `{ <name>: result }`. Runs as soon as data is
  available and again on every vault change, so make the render idempotent
  (clear, then draw).
- `s2b.data` — the latest results.
- `s2b.openNote(path)` — open a note in Obsidian. Plain `<a href>` cannot leave the
  frame; use this on click.
- `s2b.refresh()` — ask for a re-run of the queries.

## Rules
- The frame has no network: no CDN scripts, external fonts, images, or `fetch`. Every
  library-free line of code must be inline. Draw charts with inline SVG or `<canvas>`;
  there is no charting library. Keep scripts small and readable.
- Style with Obsidian's CSS variables so the view matches the theme in light and dark:
  `--background-primary`, `--background-secondary`, `--background-modifier-border`,
  `--text-normal`, `--text-muted`, `--text-faint`, `--text-accent`, `--interactive-accent`,
  `--color-red/orange/yellow/green/cyan/blue/purple/pink`, `--font-interface`,
  `--font-monospace`, `--font-ui-small`, `--radius-s/m`. The body already uses the
  interface font and has padding; override `body { padding: 0 }` if you need the edge.
- The frame follows its content height. Set `height` only when the view scrolls
  internally or uses percentage layouts; canvases and SVGs should carry explicit sizes.
- One screen, not a web app: a view is a dashboard, chart, table, or small widget.
  `alert`, `prompt`, and popups are blocked.
- Guard empty results (`rows.length === 0`) with a short message instead of a blank frame.

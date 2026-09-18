---
name: widgets
description: Build interactive widgets — dashboards, charts, plots, tables, trackers — as self-contained HTML that renders live in the chat and can be saved to the vault as a note. Use when the user asks to visualize, plot, chart, or build an overview or dashboard from vault data, or wants a small interactive widget. Load this for the widget block format and its data bridge.
metadata:
  author: "S2B"
  version: "1.0"
  category: "core"
  optionalPlugins: "dataview"
---

## What a widget is
A widget is a `s2b-widget` code fence written directly in your reply. Its body is an HTML
fragment — markup, `<style>`, `<script>` — rendered in a sandboxed frame right where you
wrote it. An optional frontmatter block at the top declares a title, a fixed height, and
named Dataview queries that the host runs for you and keeps live as the vault changes.

**Always show a widget in the chat first**, as a fence in your reply — also when the user
says "create", "build" or "make" a dashboard or chart. That *is* creating it. The user
keeps it from the toolbar above it: copy it as a block to paste into a note, or save it as
a standalone `.widget` file, which opens as its own pane and can be embedded in any note
with `![[Name.widget]]`.

Write a `.widget` file yourself only when the user explicitly asks to save, persist or
file it (or names a file or folder for it), and even then put the fence in your reply as
well. Stage the file with `manage_notes` as `<folder>/<Name>.widget` whose content is the
fence **body** only — frontmatter, then HTML, no fence markers. The widget is the
deliverable: do not wrap it in an extra note (a landing page, a note that embeds it, a
note of links) unless the user asks for one.

To **change an existing widget file**, read it first with `read_content` (it is plain text),
then stage the edit with `manage_notes` — a targeted find/replace for a small change, a full
rewrite for a redesign. The user reviews the proposal as the rendered widget — in the
chat's pending-changes bar and in the widget's open pane, with the source diff a click
away — and once accepted, the pane and every embed of that widget re-render by themselves. `search_notes` finds a saved widget by its
title and description only (never its code); if that fails, use `list_directory` on the
widgets folder or ask the user for the path.

## Format
````markdown
```s2b-widget
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
      a.dataset.note = link.path; // click opens the note, hover previews it
      row.insertCell().append(a);
      row.insertCell().textContent = new Date(modified).toLocaleDateString();
    }
  });
</script>
```
````

Frontmatter keys (all optional): `title` (toolbar label and file name when saved),
`description` (one line on what the widget shows — with the title, the only text of a saved
widget that search sees, so always give one), `icon` (shown on its tab and in the chat:
**any** name from the Lucide icon set, so choose the one that matches the widget's
*subject*, not its shape — a home dashboard gets `home`, a reading tracker `book-open`,
a study planner `graduation-cap`, a task board `list-todo`, a habit tracker `calendar-check`;
only fall back to generic chart icons like `chart-column` when nothing more specific fits;
an unknown name falls back to the default),
`height` (frame height in px; omit to size to content — with it, the layout gets that
height and the frame still shrinks if the drawn content is shorter), `queries` (name → Dataview DQL
string; use `|` for a multi-line query), `libs` (bundled libraries to load, see
[Plots and 3D](#plots-and-3d)). Body-only widgets with no frontmatter are fine for
static content.

## Data
- Each query is Dataview DQL (`TABLE`, `LIST`, `TASK`). Results arrive keyed by name:
  - `TABLE` → `{ type: "table", headers: string[], rows: unknown[][] }`. Rows are in
    header order; the first column is the note link unless `WITHOUT ID`.
  - `LIST` → `{ type: "list", items: unknown[] }`; `TASK` → `{ type: "task", items }`.
  - A failed query → `{ error: string }`. Always handle this branch visibly.
- Links are `{ path, display, subpath }`; dates and durations are ISO strings.
- Queries need the Dataview plugin. **Check "Plugin availability" above before writing
  any.** Only declare `queries` when Dataview is *enabled*. If it is disabled or not
  installed, build the widget from data you gather with your other tools (`search_notes`,
  `get_properties`, `read_content`, …) inlined as a JSON constant, and tell the user in
  one sentence that enabling or installing Dataview would let the widget query the vault
  itself and stay up to date. Never write a query that you know will fail.
- With Dataview enabled, prefer queries over inlined data whenever the data lives in the
  vault: queries stay live after the widget is saved, a constant goes stale. Inline data
  only for things that are not in the vault (a formula to plot, a worked example).

## Runtime API (inside the frame)
- `s2b.onData(callback)` — receives `{ <name>: result }`. Runs as soon as data is
  available and again on every vault change, so make the render idempotent
  (clear, then draw).
- `s2b.data` — the latest results.
- `data-note="Path/To/Note.md"` on any element makes it a note link: click opens the
  note, hovering shows Obsidian's page preview. An `<a href="Path/To/Note.md">` with a
  vault path (not a URL) works the same way. Prefer these over click handlers.
- `s2b.openNote(path)` — open a note programmatically (e.g. from a chart's click handler).
- `s2b.refresh()` — ask for a re-run of the queries.

## Plots and 3D
For charts and plots — 2D or 3D — request Plotly with `libs: plotly` and use the
global `Plotly` (standard Plotly.js API). It draws axes, legends, hover, zoom and orbit
for you. Available trace types: `scatter` (lines, markers, function plots), `bar`,
`pie`, `scatter3d`, `surface`, `mesh3d`, `cone`, `streamtube`, `isosurface`,
`volume`. Not available in this build: histogram, heatmap, contour, box — compute
those yourself and draw with `bar`/`scatter`.

````markdown
```s2b-widget
---
title: z = sin(x) · cos(y)
height: 420
libs: plotly
---
<div id="plot" style="width:100%;height:100%"></div>
<script>
  const xs = [], ys = [], z = [];
  for (let i = 0; i <= 60; i++) xs.push(-3 + i * 0.1);
  for (let j = 0; j <= 60; j++) ys.push(-3 + j * 0.1);
  for (const y of ys) z.push(xs.map((x) => Math.sin(x) * Math.cos(y)));
  const style = getComputedStyle(document.body);
  Plotly.newPlot("plot", [{ type: "surface", x: xs, y: ys, z, colorscale: "Viridis" }], {
    margin: { l: 0, r: 0, t: 0, b: 0 },
    paper_bgcolor: "transparent",
    font: { color: style.getPropertyValue("--text-muted") },
    scene: { xaxis: { title: "x" }, yaxis: { title: "y" }, zaxis: { title: "z" } },
  }, { responsive: true, displaylogo: false });
</script>
```
````

- Set `height` for Plotly widgets and give the plot div `height:100%`; Plotly needs a
  sized container. Put several plots in **one** widget (several divs) rather than one
  widget per plot: each library-backed widget carries its own copy of the library.
- Use `paper_bgcolor`/`plot_bgcolor: "transparent"` and the theme's `--text-muted` for
  fonts so the plot sits on the note like native content.
- Without a library, `<svg>` and `<canvas>` (2D and WebGL contexts) work as usual for
  hand-drawn charts, diagrams and custom rendering.

## Rules
- The frame has no network and cannot navigate: no CDN scripts, external fonts,
  images, `fetch`, links to web pages, or `location` changes — a widget that tries is
  stopped. Everything must be inline; libraries come only from `libs`. Keep scripts
  small and readable.
- Style with Obsidian's CSS variables so the widget matches the theme in light and dark:
  `--background-primary`, `--background-secondary`, `--background-modifier-border`,
  `--text-normal`, `--text-muted`, `--text-faint`, `--text-accent`, `--interactive-accent`,
  `--color-red/orange/yellow/green/cyan/blue/purple/pink`, `--font-interface`,
  `--font-monospace`, `--font-ui-small`, `--radius-s/m`. The body already uses the
  interface font; the card around the widget provides the padding, so use none of your own
  at the edges.
- The frame follows its content height — prefer that. Set `height` only when the widget
  scrolls internally or sizes children by percentage (Plotly), and then make it the
  content's real size, not a round guess: a too-large `height` shows as empty space
  under the content. Canvases and SVGs should carry explicit sizes.
- One screen, not a web app: a widget is a dashboard, chart, table, or small widget.
  `alert`, `prompt`, and popups are blocked.
- Guard empty results (`rows.length === 0`) with a short message instead of a blank frame.

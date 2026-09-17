---
name: views
description: Build interactive views — dashboards, charts, plots, tables, trackers — as self-contained HTML that renders live in the chat and can be saved to the vault as a note. Use when the user asks to visualize, plot, chart, or build an overview or dashboard from vault data, or wants a small interactive widget. Load this for the view block format and its data bridge.
metadata:
  author: "S2B"
  version: "1.0"
  category: "core"
  optionalPlugins: "dataview"
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
`height` (frame height in px; omit to size to content — with it, the layout gets that
height and the frame still shrinks if the drawn content is shorter), `queries` (name → Dataview DQL
string; use `|` for a multi-line query), `libs` (bundled libraries to load, see
[Plots and 3D](#plots-and-3d)). Body-only views with no frontmatter are fine for
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
  installed, build the view from data you gather with your other tools (`search_notes`,
  `get_properties`, `read_content`, …) inlined as a JSON constant, and tell the user in
  one sentence that enabling or installing Dataview would let the view query the vault
  itself and stay up to date. Never write a query that you know will fail.
- With Dataview enabled, prefer queries over inlined data whenever the data lives in the
  vault: queries stay live after the view is saved, a constant goes stale. Inline data
  only for things that are not in the vault (a formula to plot, a worked example).

## Runtime API (inside the frame)
- `s2b.onData(callback)` — receives `{ <name>: result }`. Runs as soon as data is
  available and again on every vault change, so make the render idempotent
  (clear, then draw).
- `s2b.data` — the latest results.
- `s2b.openNote(path)` — open a note in Obsidian. Plain `<a href>` cannot leave the
  frame; use this on click.
- `s2b.refresh()` — ask for a re-run of the queries.

## Plots and 3D
For charts and plots — 2D or 3D — request Plotly with `libs: plotly` and use the
global `Plotly` (standard Plotly.js API). It draws axes, legends, hover, zoom and orbit
for you. Available trace types: `scatter` (lines, markers, function plots), `bar`,
`pie`, `scatter3d`, `surface`, `mesh3d`, `cone`, `streamtube`, `isosurface`,
`volume`. Not available in this build: histogram, heatmap, contour, box — compute
those yourself and draw with `bar`/`scatter`.

````markdown
```s2b-view
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

- Set `height` for Plotly views and give the plot div `height:100%`; Plotly needs a
  sized container. Put several plots in **one** view (several divs) rather than one
  view per plot: each library-backed view carries its own copy of the library.
- Use `paper_bgcolor`/`plot_bgcolor: "transparent"` and the theme's `--text-muted` for
  fonts so the plot sits on the note like native content.
- Without a library, `<svg>` and `<canvas>` (2D and WebGL contexts) work as usual for
  hand-drawn charts, diagrams and custom rendering.

## Rules
- The frame has no network and cannot navigate: no CDN scripts, external fonts,
  images, `fetch`, links to web pages, or `location` changes — a view that tries is
  stopped. Everything must be inline; libraries come only from `libs`. Keep scripts
  small and readable.
- Style with Obsidian's CSS variables so the view matches the theme in light and dark:
  `--background-primary`, `--background-secondary`, `--background-modifier-border`,
  `--text-normal`, `--text-muted`, `--text-faint`, `--text-accent`, `--interactive-accent`,
  `--color-red/orange/yellow/green/cyan/blue/purple/pink`, `--font-interface`,
  `--font-monospace`, `--font-ui-small`, `--radius-s/m`. The body already uses the
  interface font; the card around the view provides the padding, so use none of your own
  at the edges.
- The frame follows its content height — prefer that. Set `height` only when the view
  scrolls internally or sizes children by percentage (Plotly), and then make it the
  content's real size, not a round guess: a too-large `height` shows as empty space
  under the content. Canvases and SVGs should carry explicit sizes.
- One screen, not a web app: a view is a dashboard, chart, table, or small widget.
  `alert`, `prompt`, and popups are blocked.
- Guard empty results (`rows.length === 0`) with a short message instead of a blank frame.

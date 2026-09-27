# Changelog

User-facing release notes, newest first. This file is the single source for
them: the plugin bundles it and shows the new sections in a "What's new" modal
after an update, and the release workflow copies a version's section into the
GitHub release body. Write the section before tagging a stable release; the
workflow refuses a stable tag without one. Pre-releases (`2.3.0-beta.1`) need no
section.

Each version is a `## X.Y.Z` heading; use `###` and below inside it. PR
references like `(#505)` become links in the modal.

## 2.2.0

Adds widgets: ask the agent for a chart, a table or a dashboard and it draws one in the chat, live from your notes.

### Widgets
- **Rendered in the chat, from a fence.** The agent writes a `s2b-widget` block and it renders in place as a sandboxed frame with no network access. Named Dataview queries in the block's frontmatter are run by the plugin and re-run as the vault changes, so the widget stays live. Plotly is bundled, so a widget can be a full interactive plot, including 3D surfaces and scatter clouds you can rotate, for studying a function or a dataset from your notes (#505).
- **Standalone `.widget` files.** Save a widget from its toolbar and it becomes a file with its own pane, embeddable in any note with `![[Name.widget]]`, searchable by title and description, and previewable on hover. Note links inside a widget open and preview like any other link. Each widget can set its own tab icon (#506).
- **Chat first, files on request.** The agent shows a widget in the reply before it ever writes a file, and does not wrap a saved widget in extra notes. Rename and Edit source live in the widget tab's menu (#507).
- **Review edits as the rendered widget.** When the agent revises a saved widget, the pending-changes bar and the widget's pane show the proposed widget itself, with the source diff a click away, and Accept applies it (#508).

Requires the Dataview plugin for query-backed widgets; without it the agent says so and still renders static ones.

## 2.1.2

Fixes the whole-app stutter while a long reply streams (#482).

### Chat
- **Streaming replies render incrementally.** The message used to be torn down and re-parsed on every frame, so a long reply pinned the main thread and the entire app stuttered until it finished. Finished blocks now stay in place and only the block being written is re-rendered. On a 6000-word reply, long tasks dropped from 60 to 2 and the stream itself no longer stalls (#503).

## 2.1.1

Stability release for the Obsidian 1.13 installer (Electron 43) and for long chats: no more renderer crash or connection error on the first send, `.chat` files stop growing by megabytes per turn, and the whole app stays responsive while a reply streams.

### Chat
- **Renderer no longer crashes on the first send under installer 1.13.x** (#492, fixes #478, #481). Electron 43 ships Node 24, whose `AsyncLocalStorage` shares a V8 slot with Blink's task scheduler; the plugin now runs its own `async_hooks`-based implementation on desktop.
- **"Connection error." on the first send under installer 1.13.x is fixed** (#501, fixes #472). The abort signal no longer crosses into Electron's main-process fetch, where Node 24 rejected it; cancellation is handled on the renderer side, including mid-stream.
- **The UI no longer stalls while a reply streams** (#484, by @Direct-Launch). Markdown is re-rendered at most once per animation frame instead of once per token.
- **`.chat` files shrink dramatically** (#483, by @Direct-Launch). Runtime callbacks were being persisted into every checkpoint; one 66 MB chat dropped to about 90 KB. Existing files shrink the next time they are saved.

### Search and indexing
- **Ollama embedding errors stop retrying for minutes** and chunks are sized to the server's `num_ctx` (#487).
- **Fresh index builds no longer race startup validation**, and the id counter survives a missing metadata record (#491, #493).
- **Note counts stay current** during and after interrupted builds (#490).
- **Stale-note detection on both indexers**, no dropped edits during builds, lighter search hits (#495, #497).
- **One transaction per note**, dirty-set graph saves, and renames without re-embedding (#498). A renamed provider keeps its indexes (#499).
- **The graph index opens when the graph view asks for it**, not at boot (#500).

### Models
- **Model lookup no longer fuzzy-matches** against models.dev (#486).

**Thanks** to @RoiArthurB, whose crash dump in #481 pinned the renderer crash to Electron 43's Node 24, to @dingsmart (#478) and @samuelueluel for the Windows and Fedora reports that confirmed it was installer-wide, to @Paxassin for the exact `AbortSignal` error in #472, and to @Direct-Launch for diagnosing and fixing #482 in #483 and #484.

## 2.1.0

Tags are now also respected in the smart graph

### Smart graph

- **Tags as nodes.** A new Scope → Tags toggle draws each tag as a node linked to every note that carries it, matching Obsidian's own graph with its Tags filter on. Tag nodes use the theme's tag colour, size by how many notes carry them, and clicking one opens Obsidian's search on that tag. Nested tags are their own nodes. (#473)
- **Tags shape topics.** Tag edges feed topic detection alongside wiki links, in both fused and link-only mode, so a vault organised by tags no longer reads as "nothing is linked". Each tag edge is damped by the tag's breadth (`1/√n` over the notes carrying it): a topical tag on a dozen notes binds them firmly, while a status tag on hundreds can't drag unrelated notes into one topic. Tags are never topic *members*: they carry no cluster of their own, don't count toward topic size, and don't fold into collapsed bubbles. (#474)
- **A topic's own tags sit inside it.** Tags that live in a topic (at least half of their notes are members) are drawn within its region, pulled to its centre, and can anchor its label. (#476)
- **Inferred links need an index, and the switch says so.** With no graph embedding index selected (or a selection whose index was removed), the Inferred links and Highlight inferred links toggles are disabled with a hint pointing at the Graph settings. The stored preference is kept, so they come alive as soon as an index is picked. (#475)
- **Changing the graph index rebuilds the graph.** Picking or clearing the index in settings previously left the old inferred edges on screen, still shaping topics, until an unrelated setting forced a rebuild. It now rebuilds on the spot; switching back to a previously used index is served from cache. (#475)

## 2.0.5

One stylesheet cleanup, no user-facing changes intended.

### Plugin review

- **The shared stylesheet no longer uses `!important` anywhere.** Every override is written as a more specific selector instead. Most of them were fighting the plugin's own component styles or an inline style on the send button rather than a theme; the one real theme conflict (Cupertino pinning the phone modal's close-button `top`) is sidestepped by offsetting the button with `translate`. (#471)
- Fixing that inline style also fixes a real bug: the send button was meant to grow to 44 px on mobile and never did. It does now. (#471)
- The search modal's filter chips sit in a plain flex box instead of `display: contents`, and the two `text-indent` resets are gone (no core or theme rule sets it). (#471)

### Still flagged, by design

Vault enumeration (indexing needs it), clipboard access (the copy-message button), and the declarative settings API (`getSettingDefinitions()`), which is planned separately.

## 2.0.4

Dependency updates and the last round of plugin-review follow-ups. No user-facing changes intended.

### Dependencies

- **Every dependency advisory is cleared** (`bun audit`: 91 → 0). Dependencies moved within their declared ranges (LangChain 1.5.x / core 1.2.x patches, deepagents 1.13, Pixi 8.20, Svelte 5.57, Vite 7.3.6, Vitest 4.1), and the transitive packages whose ranges still admitted vulnerable versions are pinned through `overrides` — all dev tooling or server-side halves of the MCP SDK that never reach the bundle. (#469)
- The build guard added in 2.0.3 did its job on the way: Pixi renamed one of its eval-based generators and the Anthropic SDK now ships its own browser stub for its local toolset, and the build refused to ship until both were accounted for. The bundle still contains no process spawning or dynamic code execution. (#469)

### Plugin review

- The stylesheet no longer uses the `@tailwind` at-rules (same output, plain CSS to any linter), an unused import is gone, and several `!important` overrides that only had to beat core's specificity are replaced with specific selectors. One of them uncovered a bug from 2.0.3: the search modal's glow border was targeting a class its element never carries; it works now. (#470)

### Still flagged, by design

Vault enumeration (indexing needs it) and clipboard access (the copy-message button). The remaining `!important` declarations override theme rules that are themselves `!important`, or raise mobile touch-target sizes.

## 2.0.3

The Obsidian plugin-review pass, and MCP goes HTTP-only. Cleanup and a removal, no new features.

### MCP servers

- **The stdio (local command) transport is gone.** Smart Second Brain now connects to MCP servers over HTTP only (Streamable HTTP, with SSE fallback), the same on desktop and mobile. Any saved stdio server is removed by a data migration on first load. A server that only speaks stdio can still be used behind an HTTP bridge such as `mcp-proxy` or `supergateway` — see the [MCP docs](https://smartsecondbrain.dev/agents/mcp/). This is what removes the plugin's ability to launch processes; see below. (#467)
- **The server dialog checks the connection for you.** No more *Test connection* button: like the provider setup modal, the connection is probed when you leave the URL or headers field, the verdict sits in the footer (checking / connected with the tool count and a list of the tools / the failure cause), and *Add Server* / *Save* unlock once the server has actually connected. Editing a server without touching its URL or headers can still be saved while the server happens to be unreachable. (#467)
- Probes never run mid-keystroke, and when editing a server that has headers, a URL on a different host than the saved one puts the probe on hold with an explicit *check now* — so stored credentials are never sent to a new host as a side effect of retyping a URL. (#467)
- The dialog's footer no longer leaves a gap above the buttons, and the confirm buttons stay together on one line. (#467)

### Obsidian plugin review

Obsidian's automated review had flagged the plugin. Everything in that report that lives in our own code is resolved, and the two behaviour findings that came from bundled dependencies are resolved too:

- **No process spawning or dynamic code execution in the bundle.** The MCP SDK's stdio transport and `ajv` validator, the Anthropic SDK's local agent toolset, and Pixi's code generators are swapped for shims at build time; Pixi runs on its supported eval-free path and the MCP SDK validates tool results with its own interpreter-based provider. The build fails if any of these ever reappear. (#467)
- Language detection uses Obsidian's `getLanguage()`, and the bulk-indexing crash marker persists through Obsidian's vault-scoped storage instead of raw `localStorage`. (#465)
- Deprecated Obsidian and LangChain APIs replaced, DOM built through Obsidian's helpers, inline styles moved to CSS classes, promise handling made explicit, and IndexedDB failures always surface as real `Error`s. No user-visible change intended; the graph, search modal, diff action bars, indexing notice and phone-sheet modals were checked live. (#465)
- INFO-level plugin logging now goes to the console's *Verbose* level, per Obsidian's guidelines. Turn on Verbose in the developer console to see it. (#465)

### Still flagged, by design

Vault enumeration (indexing needs it) and clipboard access (the copy-message button).

## 2.0.2

Two rounds of bug fixes since 2.0.1, plus clearer feedback when connecting a provider.

### Provider setup

- **You can now tell when a provider actually connected.** The Setup Provider modal has no
  submit button — credentials autosave and the provider commits itself once validation
  passes — so a successful setup looked identical to an untouched form. The only signal was
  a small check in the title bar, easy to miss and in some cases not rendered at all. There
  is now a connection status row in the modal itself (checking / connected / the actual
  error message) and an explicit **Done** button. This was especially confusing during
  onboarding, where nothing told you the provider had been added or that you could close the
  dialog. (#461)
- Providers configured with a stored API-key secret previously got no in-modal confirmation
  at all — the old success styling only ever applied to plain text fields. (#461)
- Fixed a race where finishing setup could leave the provider's ID and its displayed name
  disagreeing, or report a spurious "Provider not found" on a provider that had connected
  fine. (#463)

### Fixes

- Popout windows: timers and DOM globals are now scoped to the correct window, so features
  used in a popped-out pane behave the same as in the main window. (#462)
- Assorted correctness fixes across chat, graph, search, and the vector store found during a
  review pass. (#462)

## 2.0.1

A patch release fixing a skill-editor bug that could destroy a customized skill, plus signed build provenance for the release assets.

### Fixed

- **Skill diff compared against the wrong baseline.** Opening "Diff with default" on a skill compared its `SKILL.md` against the *agent system prompt* instead of the skill's shipped body — two unrelated documents, so the whole pane highlighted and the default side appeared to be missing its frontmatter. **"Use default" shared that value**, so pressing it would have overwritten your skill with the agent base prompt. Both surfaces now use the skill's own bundled body.

### Added

- **Build provenance attestations** for `main.js` and `styles.css`. You can verify a downloaded asset came from this repository and workflow:

  ```
  gh attestation verify main.js --repo s2b-dev/smart-second-brain
  ```

  This is the first release with attestations; 2.0.0's assets predate them.

### Changed

- README leads with Features before Install.
- Internal: vendor logos are cached as elements rather than reparsed markup, and `package.json` now carries the real version (it still said `0.1.0`).

### Upgrading

No action needed. No settings, vault files, or index formats change, and `minAppVersion` stays at 1.11.4.

## 2.0.0

The first stable release since 1.3.0. Smart Second Brain has grown from a chat-with-your-notes plugin into three features that each work on their own: search, a graph that groups your notes into topics, and an agent that can read and edit your vault with your approval.

Full feature documentation is at [smartsecondbrain.dev](https://smartsecondbrain.dev).

### 🔍 Search

- Full-text search with fuzzy matching, tag and folder filter chips, and recency-aware ranking.
- PDF content is indexed, so results turn up files Obsidian's own search cannot find.
- Semantic search: press Tab to run the same query by meaning. Requires an embedding model, which can run locally through Ollama.
- A search that finds nothing can be handed to the agent as a question, or turned into a new note without leaving the box.

### 🕸️ Smart Graph

- Notes are grouped into topics automatically with Leiden community detection, drawn as tinted regions with name pills.
- Granularity moves between a few broad topics and many narrow ones; the levels nest, so a topic at one level is always part of one topic at the level below.
- Immerse: select a topic and the graph rebuilds around just those notes, revealing the finer topics inside it.
- Bridge notes and orphans are highlighted. With an embedding model, the graph also draws inferred edges between notes that are about the same thing but never link to each other.
- Rendering goes through PixiJS, with clustering, projection and the neighbour scan in web workers.

### 🧠 Agents

- Tool-using agents that search and read your vault before answering, and cite what they used as wikilinks.
- Every note edit is staged for review as an inline diff. Nothing is written to disk until you accept it, per hunk or all at once.
- Skills: capability is defined by folders holding a `SKILL.md`, in the open [Agent Skills](https://agentskills.io/specification) format. Four core skills ship with the plugin; agents can also write their own.
- Memory: plain notes under `Agents/Memories/`, readable and editable like anything else in the vault.
- Chats are notes: conversations are `.chat` files, indexed and searchable, with branching history, and embeddable in a note with `![[Conversation.chat]]`.
- Integrations with Dataview, Tasks, TaskNotes, Canvas and Bases, plus auto-discovery of any plugin exposing an `api`.
- MCP servers per agent, over HTTP and stdio.
- Multiple agents on different models running in parallel, subagents, and image and PDF attachments.

### 🔒 Privacy

- Vault-wide private by default or public by default, refined per note or per folder.
- Local providers (Ollama, oMLX) are trusted; cloud providers are untrusted and blocked from reading, embedding, or being sent a private note. The block is enforced in the plugin.
- Search and the graph never send anything anywhere. No telemetry.

### 🔌 Providers

Ollama, oMLX, OpenAI, Anthropic, OpenRouter, and any OpenAI-compatible endpoint.

### 📱 Platform

Desktop and mobile. Requires Obsidian 1.11.4 or later.

### ⬆️ Upgrading from 1.x

The plugin migrates its data on first run: agent context is consolidated under the `Agents/` folder, and the bundled core skills are seeded into your vault. Chats from 1.x are converted to the `.chat` format on load.

Because the retrieval stack changed, the vector index is rebuilt on first launch. It runs in the background with progress in the status bar and is incremental after that.

If you sync your vault, exclude `.obsidian/plugins/smart-second-brain/` from sync to avoid version-history bloat from the index.

### 💬 Feedback

This is a big release, and the surest way it gets better is hearing how it goes in your vault. Bug reports and feature requests belong in [issues](https://github.com/s2b-dev/smart-second-brain/issues/new/choose), questions in [Q&A](https://github.com/s2b-dev/smart-second-brain/discussions/categories/q-a), and if you build a skill or an agent you like, we'd genuinely love to see it in [Show and tell](https://github.com/s2b-dev/smart-second-brain/discussions/categories/show-and-tell).

We started this as a university project. That finished a long time ago — we keep building it because we use it every day. Thanks for trying it.

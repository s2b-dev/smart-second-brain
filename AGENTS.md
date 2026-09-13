# AGENTS.md

This file provides guidance to coding agents working in this repository.

## Project

Smart Second Brain is an Obsidian plugin (`smart-second-brain`) that turns the vault into an AI-assisted second brain: chat-with-your-notes via a RAG pipeline, a smart graph view, and provider-agnostic LLM support (OpenAI, Ollama, oMLX, Anthropic, OpenRouter, OpenAI-compatible endpoints). Runs on desktop and mobile (`isDesktopOnly: false`). Stack: Svelte 5 (runes) + TypeScript + Vite + LangChain/LangGraph, with Tailwind for styles, Biome for lint/format, Vitest for tests, and Bun as the package manager.

## Contributing

Human-facing contribution rules (branch model, PR expectations, the AI-assistance policy,
provider and skill recipes) live in [CONTRIBUTING.md](CONTRIBUTING.md). CI (`.github/workflows/ci.yml`)
runs the Biome format and lint checks, `bun run check`, `bun run test`, and `bun run build` on every pull request; a
change that fails any of those locally will fail there too.

**Disclose AI involvement; never hide it.** Most of this repo is written by coding agents
working from the maintainer's briefs, and the history should say so:
- Commits made from Claude Code carry a `Co-Authored-By: Claude <noreply@anthropic.com>`
  trailer, configured in `.claude/settings.json` (it overrides the user-level setting). Keep
  the trailer. If you commit through another agent, add a trailer naming *that* agent instead;
  never attribute a change to an agent that did not make it.
- Every PR body follows `.github/PULL_REQUEST_TEMPLATE.md`, including the **AI assistance**
  section. Fill it in honestly in one or two lines: which agent wrote the change, from what
  brief, and what the human reviewed and tested. Do not leave the section out. "none" is the
  right answer only for a change no agent touched, which a change you are making is not.
- Replies to review-bot findings are written by whoever is driving the loop, agent or human;
  that is fine. Replies to a *person's* review are the maintainer's to write.

## Commands

Use `bun` (not npm/yarn). The lockfile is `bun.lock`.

- `bun run dev` — Vite watch build to `build/smart-second-brain/` (development).
- `bun run build` — production build to `build/prod`.
- `bun run check` — `svelte-check` over both `tsconfig.json` (src) and `tsconfig.test.json` (tests + integration). **Run after each implementation.** `check:src` / `check:test` run one pass each.
- `bun run format` — Biome formatter (writes) over `src`, `test`, `integration`. **Run after each implementation.**
- `bun run lint` — Biome linter, safe autofixes only, same three dirs.
- `bun run lint:unsafe` — adds `--unsafe`. Review the diff afterwards; these fixes can
  change behaviour rather than just style. Two real examples from this repo: `delete obj[k]`
  → `obj[k] = undefined` (leaves the key present, so a rename stops being a rename), and
  `x && x.f()` → `x?.f()` where `x` is a non-nullable string (turns an emptiness check into
  a nullishness one). Prefer fixing by hand when the rule touches control flow.

Tests are type-checked, not just formatted: `tsconfig.json` covers only `src/**`, so
`tsconfig.test.json` extends it to `test/**` and `integration/**` (it stays separate so test
files can never influence the production build). This is not cosmetic — while the suites went
unchecked, a `resolveSegments` call kept passing a removed argument, silently returned `[]`,
and made four assertions pass vacuously.

Two Biome settings exist for the test tree, both in `biome.json` (which is strict JSON and
rejects comments, hence the note here):
- `files.ignore` excludes `integration/S2B Test Vault/**` — third-party plugin bundles,
  themes, and Obsidian's own config, which Obsidian rewrites on every launch. Never format it.
- An `overrides` entry disables `style/noNonNullAssertion` for `test/**` and `integration/**`.
  `expect(store.getAgent(id)!.name)` is the point in a test: if the lookup fails, the test
  should throw. The rule stays on for `src/`.
- `bun run test` — Vitest unit tests (single run). `bun run test:watch` for watch mode. `bun run test:coverage` for coverage.
- `bun run test -- <pattern>` — single file/pattern, e.g. `bun run test -- test/providers/openai.test.ts`.
- `bun run test:integration` — end-to-end tests against a live Obsidian instance (see Integration tests below).
- `bun run setup-vault` — symlinks `build/smart-second-brain/` into `integration/S2B Test Vault/.obsidian/plugins/`. Run once after the first build.

There is no separate `bun install` step needed beyond what `bun.lock` records; do **not** edit `package.json` versions manually without re-locking.

## Documentation lives on the site, not in the README

User-facing documentation lives in the **`s2b-dev/site`** repo (checked out at
`../site`), published at `smartsecondbrain.dev`. The README here is deliberately
minimal — pitch, install, development setup, links. Do not add feature lists,
provider tables, or FAQ content back into it; that duplication is what caused
the README to drift out of date.

**Before cutting a release**, refresh the site's enumerable facts — it is not
automated. The checklist lives in `../site/CLAUDE.md` under "Before a plugin
release" and covers the provider list, bundled skills, built-in tools,
`minAppVersion`, and platform support. Changing `PROVIDER_TEMPLATES`,
`BUILT_IN_TOOL_IDS`, `src/skills/defaults/`, or `manifest.json` means the site
needs updating too.

The plugin also links *into* that site from several surfaces (Troubleshooting
settings, the privacy row, onboarding, provider setup, the Agent editor). Every
one of those URLs lives in `src/utils/docs.ts` — never inline a
`smartsecondbrain.dev` URL at a call site. That file is a contract with the
site's routes: when they move, reconcile it against `../site/dist/sitemap-0.xml`
and the `redirects` block in `../site/astro.config.mjs`. Rendering goes through
`components/ui/DocsLink.svelte` (icon variant for setting rows via `nameSuffix`,
inline variant for section descriptions).

**Never open an external `http(s)` URL with `window.open`.** Obsidian's iOS
WKWebView never implements window creation, so it returns null unconditionally
there and the click silently does nothing — verified on-device (see
`navigateToAuthorizeUrl` in `providers/openrouterOAuth.ts`). Render an anchor
instead: `components/ui/ExternalLinkButton.svelte` covers the common case of a
setting row wanting something that *looks* like a button, and matches Obsidian's
button metrics (`height: var(--input-height)`, `4px 12px`) so it sits flush next
to real ones. `obsidian://` deep links are exempt — the app's protocol handler
takes those, no window involved.

## Architecture

This section is the canonical description of the architecture. (A longer
`docs/architecture-overview.md` existed but went stale and was removed in
August 2026; recover it from git history if useful, but do not trust it.)

### Composition root

`src/main.ts` (`SecondBrainPlugin`) is the single owner of lifecycle. It:
- Constructs the data store, then registers views/commands/extensions synchronously.
- Defers heavy init (`LexicalSearchService`, `VectorStoreService`, `SkillsService`, `AgentManager`) to `onLayoutReady` so the workspace renders immediately. If a chat opens before init finishes, `AgentManager.ensureAgent()` lazy-initializes.
- Patches `WorkspaceLeaf.prototype.openFile` so `.chat` files always open in the configured sidebar split rather than replacing the active note.
- Registers three views: `VIEW_TYPE_CHAT` (`.chat` FileView), `VIEW_TYPE_SMART_GRAPH`, `VIEW_TYPE_ONBOARDING`. (`VIEW_TYPE_NOTE_CONTEXT` exists but is **disabled for the initial release** — its registration, command and activator are commented out in `main.ts`.)

### Layered structure

- `src/agent/` — LLM orchestration. `Agent.ts` wraps LangChain React-agent execution and streaming; `AgentManager.ts` is the Obsidian-facing facade that registers providers, binds tools (`tools/`), assembles the system prompt from base prompt + selected skills, and resolves multimodal capability dynamically per model. `ObsidianChatManager.ts` is a custom LangGraph checkpoint saver: threads stored as gzipped-JSON `.chat` files in the vault, fast index in plugin data. Because LangGraph repeats the full message history in every checkpoint (and again in `Send` task payloads), the file format dedups every message into a content-addressed `messageTable` (`threadDataCodec.ts`, format v2; legacy files are rewritten on load) — without it, long threads grow O(N²) (#431). **Conversation history is a tree of checkpoints, not a flat list** — edit/regenerate creates branches.
- `src/providers/` — Template-aware provider definitions (one file per vendor) plus a singleton runtime `registry.ts` holding only **configured** providers. OpenAI-compatible is treated as a first-class template. Multiple instances per template are supported with distinct display names/endpoints.
- `src/vectorstore/` — Hybrid retrieval. `VectorStoreService.ts` owns index lifecycle and supports multiple indexes keyed by embedding model (chat retrieval and graph analytics can use different models). `HNSWVectorStore.ts` + `hnswWorker.ts` for ANN; `MiniSearchService.ts` for BM25-style lexical fallback (works without any embedding model configured). Search queries are wrapped in the embedding model family's retrieval instruction at query time (`queryInstruction.ts`: Qwen3-Embedding/harrier `Instruct: …\nQuery:`, BGE/mxbai sentence prefix); documents are embedded raw, so this is query-only and never requires a reindex.
- `src/search/` — Query planning, lexical scoring, recent-notes boosting, final ranking pipeline used by the search modal and `search_notes` tool.
- **Agent context lives under one vault folder.** All of an agent's editable context is consolidated under a single configurable root, `agentFolder` (default `Agents/`), with three fixed subdirectories, so everything the system prompt is built from is a real, user-visible note:
  - `Agents/Memories/` — shared working-memory notes (global across agents; writes inside it always auto-approve).
  - `Agents/Skills/` — skill `<name>/SKILL.md` dirs. **Everything is a skill**: the 4 former capabilities (`vault`, `notes`, `web`, `update`) ship as bundled **core skills** whose body is their guidance and whose `allowed-tools` frontmatter attaches built-in tools; user skills are the same thing with no attached tools. Discovery scans this folder and treats every `SKILL.md` dir as a skill (no reserved names, no `GUIDANCE.md`).
  - `Agents/<Agent Name>/AGENT.md` — one folder per agent, holding its definition note. The note's **body IS the system prompt**: base instructions, the `# Current Date` section, and the `# Memory` section, all in one editable place. There is no memory toggle — an agent participates in memory iff its note still has that section, which the user can simply delete. The folder is the unit rename/duplicate/delete operate on (see `PromptFilesService`).
  The whole tree is plugin machinery, excluded from indexing/search/graph via `isAgentFilePath` in `utils/fileFiltering.ts` (path helpers in `utils/agentPaths.ts`). One deliberate exemption: `list_directory` always shows `Agents/Memories/` — memory notes are absent from the search index, so that listing is the agent's only memory-discovery path (the default `# Memory` section directs it there). Legacy installs are consolidated on first run (`SkillsService.migrateAgentFolder`, from the old top-level `Skills/` folder or the pre-vault `<configDir>/skills`); the v6 `migrateCoreSkills` deletes orphaned per-core-skill `GUIDANCE.md` files so the bundled core-skill `SKILL.md`s seed cleanly into the same dirs.
- `src/skills/` — Two-phase skill system (Agent Skills style): discover frontmatter on startup, load full content on demand. Bundled defaults under `src/skills/defaults/` (including the `vault`/`notes`/`web`/`manage-skills` core skills — the last one was named `update-skills` before it gained create/delete, migrated in schema v8). **`allowed-tools` is load-bearing**: `AgentManager.buildToolsForAgent` binds a built-in tool only when some *enabled* skill attaches it via `allowed-tools` AND the per-tool `toolsConfig[toolId].enabled` override hasn't vetoed it. All skill guidance reaches the model lazily — advertised by description in the `# Skills` `<available_skills>` block, body loaded on demand via `load_skill`; a skill whose declared built-in tools are *all* vetoed by per-tool overrides is hidden from both surfaces (`AgentManager.skillHasUsableTools`), so the model is never taught a tool that won't be bound. The `manage_skills` tool (the opt-in "Manage Skills" core skill) lets an agent create new skills, revise its own attached skills, or delete skills it created; unlike `manage_notes`, every operation applies immediately with no `pendingChangesStore` review step — creating a skill is the same action as attaching it. A created skill gets no explicit `agent.skills` entry, so it reads as attached (`?? true`) the moment its file exists on disk. `allowedTools` on a new skill is filtered through a fixed read-only allow-list, never passed through verbatim — the one guard against an agent granting itself new capability via a skill it just wrote. Deleting a built-in core skill is refused (it would just reappear via `bootstrapDefaultSkills` on next startup). Because a tool can be attached by more than one skill (e.g. an integration skill re-declaring a tool a core skill already owns), per-tool overrides are **not** configured per-skill — they live in one agent-level `ToolsModal` (opened from the "Tools" row in the Agent editor's General section), which lists all `BUILT_IN_TOOL_IDS` flat and shows each tool's attaching skill(s).
- `src/agent/promptFiles.ts` — File-backed store for each agent's `<Agent Name>/AGENT.md`. The code constant `DEFAULT_AGENT_PROMPT` remains the factory default the diff/reset UI compares against; the file is the editable copy. Values that must stay live are written into the body as placeholders (`{{memoryFolder}}`, `{{date}}`) and substituted by `substitutePromptPlaceholders` at assembly, so nothing stale is ever baked into stored text; assembly appends only what is irreducibly dynamic (the `# Skills` block, the no-write-tools guard). Each note carries a small plugin-managed frontmatter block (`author`, `version` — flat keys, so Obsidian's Properties UI renders them) whose `version` records the shipped baseline the body was written from, mirroring how skills version their SKILL.md; it is what makes "the default moved under YOUR edit" detectable, and it travels with the note through sync/copy (duplicating an agent copies the notes verbatim, provenance included). Everything model-facing uses the frontmatter-stripped **body** only — assembly, the diff modal, and the shipped-history fingerprints — so restamping never reads as a customization. Content is cached in memory as parsed body+version (populated at init + on vault change) so `assembleSystemPrompt` and the reactive stale-guidance getter read it without hitting disk. Editing happens in the vault note (pencil/"open note"); the `SystemPromptModal` diff modal stays for comparing against the default and resetting. Because the note lives in a folder of its own, rename/duplicate/delete are directory operations. (Skill/tool guidance is no longer stored here — it's the skill body, edited via the note / `manage_skills`.)
- `src/stores/` — Reactive state via Svelte 5 runes (`*.svelte.ts`). `dataStore` is canonical config + secrets indirection (its non-store residents live beside it: `agentDefaults.ts` for the default agent + load-time normalization, `dataMigrations.ts` for the schema version + migration table, `staleGuidance.ts` for the prompt-staleness detector); `chatStore` owns `ChatSession` and the `SessionRegistry`, while everything that *derives* the timeline from checkpoint history (checkpoint graph, `MessagePair`s, tool timelines, summarization markers, context blocks) is the pure, rune-free `chatTimeline.ts`; `pendingChangesStore` stages note mutations for review. `state.svelte.ts` is a leaf (plugin handle only) — nothing under `stores/` may be imported by `providers/*` or `utils/*`; see the import-cycle rule below.
- `src/components/` — Feature-vertical Svelte UI: `chat/`, `graph/`, `settings/`, `modal/`, plus shared `ui/` primitives. Markdown rendering goes through Obsidian's renderer (not a custom one). A modal whose body is a Svelte component extends `modal/SvelteModal.ts` (`mountComponent(component, props, layout?)`; it owns mount/unmount and the layout override) rather than re-implementing the lifecycle.
- `src/views/` — Thin Obsidian view wrappers (`ItemView`/`FileView`/`PluginSettingTab`) that mount Svelte components. Svelte-bodied `ItemView`s extend `views/SvelteItemView.ts`, the view-side twin of `SvelteModal`.
- `src/editor/` — CodeMirror extensions (`inlineDiffExtension`, `selectionHighlightExtension`) and a markdown post-processor for reading-view diffs. Pending-change refresh is event-driven via the custom `s2b-pending-changes-updated` DOM event.
- `src/lib/` — Adapters that hide host quirks: `obsidianFetch.ts` (native fetch first, `requestUrl` fallback for CORS), `aiTransport.ts` (streaming-mode fallback), `secretStorage.ts`, `query.ts` (TanStack Query), `i18n.ts` + `en.json` (English only at present).
- `src/hooks/` — Svelte 5 reactive context helpers (`*.svelte.ts`): visible notes, selection, available models, secrets.
- `src/utils/` — Pure helpers (PDF extraction, clustering/projection, worker orchestration via `computeWorkerManager.ts`, token estimation, wikilink extraction).

### Cross-cutting

- **Staged writes:** Tools that mutate notes go through `pendingChangesStore` for user review rather than applying immediately. The review loop is closed in both directions: the outcomes (accepted / rejected / partially applied, plus still-pending paths) are injected into the model's next user turn as a context block via the same augment/strip mechanism as visible notes, and a same-thread re-stage of an already-pending update is rebased onto the pending proposal's `newContent` so the superseding proposal carries both rounds of edits. Entries are keyed by the model's tool-call id (`config.toolCall.id`), which lets the chat's `manage_notes` card show live review-status chips. A proposal whose note changed after staging can never be accepted (unconditional conflict check at apply time, including deletes); every review surface — chat bar, in-chat hunks, edit-mode and reading-view action bars — detects this and disables Accept with an explanation instead of letting it error.
- **Worker offload:** Graph projection/clustering and HNSW operations run in workers (`hnswWorker.ts`, `computeWorker.ts`) to keep the UI fluid.
- **Capability-driven multimodal:** Vision/PDF support is resolved per model at runtime — do not hard-code provider assumptions.
- **Secrets:** `dataStore` holds secret IDs, not raw values; raw values resolve through `secretStorage.ts`.
- **No runtime import cycles.** `bunx madge --circular --extensions ts src/main.ts` with a `.madgerc` of `{"detectiveOptions":{"ts":{"skipTypeImports":true,"skipAsyncImports":true}}}` reports none; keep it that way. The seams that make this hold: `providers/*` never import `stores/dataStore` (they read through `getPlugin()` from the leaf `state.svelte.ts`, and `providerRuntime` announces Codex session changes via `onCodexSessionChange`, which `main.ts` wires to query invalidation); `utils/agentPaths` and `utils/fileFiltering` read the agent folder from `utils/agentPathSource.ts`, which `PluginDataStore` installs on construction; UI-opening helpers in `utils/actionNotice.ts` use dynamic `import()` for the modals and services they open. Built-in tool metadata (display name, UI summary, stored default `ToolConfig`) has exactly one table, `agent/tools/builtInToolDefaults.ts`.

## Build

`vite.config.ts` outputs a CommonJS bundle as `main.js` for Obsidian. Externals: `obsidian`, `electron`, all `@codemirror/*` and `@lezer/*` (provided by host), `@sap-ai-sdk/langchain` (optional dep), and Node builtins. Dev mode emits to `build/smart-second-brain/` with sourcemaps; production wipes and emits minified to `build/prod`.

Tests mock `obsidian`, `electron`, and `@sap-ai-sdk/langchain` via `test/__mocks__/` aliases in `vitest.config.ts`. The unit suite uses `jsdom`, runs `pool: forks` with `fileParallelism: false` and `mockReset: true` to prevent leakage. Coverage scope is `src/providers/**` only.

## Code conventions

- **Biome** governs lint/format. Tabs (width 4), line width 120, semicolons always, trailing commas everywhere. `useConst` and `useImportType` are off. Imports auto-organize.
- **Svelte 5 runes:**
  - Use `$effect` for: DOM manipulation (canvas, animations), third-party library integration, cleanup (timers, listeners), one-time init, browser-only operations (analytics, logging).
  - **Avoid `$effect`** for state synchronization (don't sync state between variables) or for computed values (use `$derived`).
- **Custom components over raw HTML.** This project has Obsidian-styled wrappers — use them. In particular: every form control in settings must be wrapped in a `SettingContainer` (with `name=` and `desc=`) so the layout matches Obsidian conventions:
  ```svelte
  <SettingContainer name="API Key" desc="Your provider API key">
      <TextComponent inputType="password" bind:value={apiKey} />
  </SettingContainer>
  ```
- **Prefer Obsidian's native styling over custom CSS.** Match native look/behavior wherever possible instead of reinventing it. For icon buttons use the native `.clickable-icon` class (it already provides the transparent-at-rest → `--background-modifier-hover` highlight, native rounding, and cursor) rather than hand-rolled hover backgrounds. Lean on Obsidian's CSS variables (`--background-modifier-hover`, `--radius-s`, `--text-muted`, etc.) so the plugin tracks the user's theme. Only add custom CSS when native genuinely can't express the intent.

## Verifying changes in a live vault

Prefer the Obsidian CLI for manual verification over editing-and-hoping. Always target the test vault by name, with `vault=` **first**:

```bash
obsidian vault="S2B Test Vault" command id=smart-second-brain:search-notes
obsidian vault="S2B Test Vault" dev:dom selector='.s2b-search-modal' total
obsidian vault="S2B Test Vault" dev:screenshot path="/tmp/search-modal.png"
obsidian vault="S2B Test Vault" dev:errors
```

Stable manual flow:
1. Open the test vault once in the Obsidian desktop app.
2. Run a `command`.
3. **Poll** for the selector before inspecting — some commands return before the UI mounts. Don't assume failure if a modal isn't there immediately.
4. Use `command`, `dev:dom`, `dev:screenshot`, `dev:errors`. Reserve `eval` and `dev:cdp` for cases where DOM queries and screenshots are insufficient — they're more brittle.

Known issue: on macOS, launching `obsidian` from Codex Desktop can cause Obsidian to quit unexpectedly (upstream `openai/codex#13706`). If that happens, run the CLI from a normal terminal instead, or reopen the vault and minimize CLI calls. Reference flow lives in `integration/helpers/cli.ts`; see also the `obsidian-integration-test` skill under `.github/skills/`.

## Parallel agent slots

Multiple agent sessions can work simultaneously without racing on builds or
trampling each other's live vault. Three **fixed slots** live as siblings of
this repo (created once by `bun run setup-slots`, which is idempotent):

```
s2b-dev/
├── smart-second-brain/     ← main checkout: the USER's. Never build here
│                             while working in a slot — vault symlinks for
│                             the user's live testing point at ITS build/.
└── agents/
    ├── wt1/                ← git worktree (own node_modules, own build/)
    ├── S2B WT1/            ← Obsidian vault, plugin symlinked → wt1/build/
    ├── wt2/  +  S2B WT2/
    ├── wt3/  +  S2B WT3/
    └── .locks/             ← slot claims
```

**Protocol** for any task that needs a build or live verification:

1. `scripts/claim-slot.sh <task-or-branch-name>` — claims the first free slot
   and prints its worktree dir and vault name. If none is free, ask the user
   rather than working in the main checkout. `--status` lists holders.
2. `cd` into the slot worktree. It sits on a detached HEAD; create your task
   branch there (`git fetch && git switch -c <branch> origin/main`). Run
   `bun install --frozen-lockfile` if deps changed.
3. Build with a **one-shot** `bunx vite build --mode development` (never a
   `--watch` — lingering watchers were the historical source of corrupt
   bundles). Output goes to the slot's own `build/smart-second-brain/`.
4. Verify live against **your slot's vault only**, e.g.
   `obsidian vault="S2B WT1" command id=app:reload` then the usual
   `command`/`dev:dom`/`dev:screenshot`/`dev:errors` flow. Never target
   `S2B Test Vault` or the user's vaults from a slot session.
5. Integration tests can target the slot vault via env vars:
   `S2B_TEST_VAULT="S2B WT1" S2B_TEST_VAULT_PATH="../agents/S2B WT1" bun run test:integration`
   (absolute path preferred). Caveat: running the full suite from **two slots
   at the same time** is unvalidated — the suite assumes a quiet Obsidian
   instance (`globalSetup` does a disable/enable cycle). Prefer live CLI
   verification for parallel work; coordinate with the user before
   concurrent full-suite runs.
6. **After opening the PR, drive the automated review to a clean state
   before calling the task done.** The repo has a PR review bot (Greptile);
   it reviews every pushed commit within a few minutes. Poll with
   `gh pr view <n> --json comments,reviews` (summary) and
   `gh api repos/s2b-dev/smart-second-brain/pulls/<n>/comments` (inline
   findings), every ~2 minutes. Address EVERY finding: fix real issues and
   push, or reply on the comment with a short justification when the bot is
   wrong. Repeat until the bot's latest review covers your newest commit
   with no unresolved findings (the bot's summary comment footer names the
   last reviewed commit). Do not merge — merging is the user's call after
   their own live test.
7. `scripts/release-slot.sh <wtN>` once the PR is bot-clean. Leave the
   worktree clean. If the user's live test later requires rework, claim a
   slot again for the follow-up.

One-time host setup: each slot vault must be registered with Obsidian once.
`setup-slots` does this automatically when Obsidian is closed; otherwise open
each `agents/S2B WT<n>` folder as a vault by hand.

`bun run check` / `format` / `lint` / `test` all work inside a slot worktree.

## Integration tests

`integration/` runs Vitest against a live Obsidian via the CLI (`integration/helpers/cli.ts`). Setup:

1. `bun run build`
2. `bun run setup-vault` (one-time symlink)
3. Open `integration/S2B Test Vault` in Obsidian and enable the plugin.
4. (Optional) Configure a provider with valid API keys for LLM-dependent tests.
5. `bun run test:integration` — or a single file: `bunx vitest run --config vitest.integration.config.ts integration/plugin-lifecycle.test.ts`

Tests run **sequentially** (`fileParallelism: false`, single shared Obsidian instance), 120s timeout, 1 retry. Tests requiring an LLM (`agent-interaction`, `chat-e2e-flow`, `multi-turn`) auto-skip when no provider is configured but **fail** if a provider is configured with invalid keys. To skip them entirely:

```bash
bunx vitest run --config vitest.integration.config.ts --exclude 'integration/{agent-interaction,chat-e2e-flow,multi-turn}.test.ts'
```

`globalSetup.ts` performs a disable/enable cycle before the suite to start clean.

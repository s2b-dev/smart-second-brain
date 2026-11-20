# Integration Tests

End-to-end tests that run against a live Obsidian instance using the `obsidian` CLI.

## Prerequisites

- **Obsidian desktop app** installed with the [Obsidian CLI](https://obsidian.md) enabled
- **Bun** runtime

## Setup

1. **Build the plugin:**

   ```bash
   bun run build
   ```

2. **Link the plugin into the test vault:**

   ```bash
   bun run setup-vault
   ```

   This creates a symlink from `integration/S2B Test Vault/.obsidian/plugins/smart-second-brain` → `build/smart-second-brain`.

3. **Open the test vault in Obsidian:**

   Open Obsidian → Manage Vaults → Open folder as vault → select `integration/S2B Test Vault`.

4. **Enable the plugin:**

   In Obsidian, go to Settings → Community plugins → enable **Smart Second Brain**.

5. **(Optional) Configure an LLM provider:**

   Some tests require a working LLM provider with valid API keys. In the test vault, open plugin settings and configure a provider (e.g. OpenAI, Ollama). Without this, LLM-dependent tests will be **skipped** automatically.

## Running Tests

With the test vault open and focused in Obsidian:

```bash
bun run test:integration
```

To run a single test file:

```bash
bunx vitest run --config vitest.integration.config.ts integration/plugin-lifecycle.test.ts
```

To run only the tests that don't require API keys:

```bash
bunx vitest run --config vitest.integration.config.ts --exclude 'integration/{agent-interaction,chat-e2e-flow,multi-turn}.test.ts'
```

## Test Files

| File                               | Requires LLM | What it covers                                        |
| ---------------------------------- | ------------ | ----------------------------------------------------- |
| `plugin-lifecycle.test.ts`         | No           | Install, enable, reload, command registration         |
| `views.test.ts`                    | No           | View type registration and opening                    |
| `chat-ui.test.ts`                  | No           | Chat view DOM structure and UI elements               |
| `chat-lifecycle.test.ts`           | No           | Chat creation and management                          |
| `chat-files-and-stability.test.ts` | No           | `.chat` file handling and plugin stability under load |
| `search-modal.test.ts`             | No           | Semantic search modal UI and results                  |
| `smart-graph.test.ts`              | No           | Graph view rendering and controls                     |
| `vault-operations.test.ts`         | No           | Vault file CRUD and plugin resilience                 |
| `semantic-search.test.ts`          | No           | Semantic search functionality                         |
| `chat-e2e-flow.test.ts`            | **Yes**      | Sending messages and receiving responses              |
| `multi-turn.test.ts`               | **Yes**      | Multi-turn conversation context retention             |
| `agent-interaction.test.ts`        | **Yes**      | Agent selection and interaction                       |

Tests marked **Yes** use `skipIf(!providerAvailable)` to auto-skip when no provider is configured. However, having a provider _configured_ without valid API keys will cause these tests to fail rather than skip — make sure the credentials are actually valid.

## How It Works

- Tests use `child_process.execSync` to call `obsidian` CLI commands (see `helpers/cli.ts`)
- The global setup (`globalSetup.ts`) performs a full disable/enable cycle before the suite to ensure a clean state
- Tests run **sequentially** (`fileParallelism: false`) since they share a single Obsidian instance
- Each test has a 120s timeout and 1 automatic retry
- Provider availability is checked via `isProviderConfigured()` which looks at whether the plugin has any configured providers — this does **not** validate that the API keys are correct

## Writing New Tests

```typescript
import { describe, expect, it } from "vitest";
import { obsidian, getErrors, clearBuffers, sleep } from "./helpers/cli.ts";

describe("my feature", () => {
  it("should work without errors", async () => {
    clearBuffers();

    // Execute an action
    obsidian("command id=smart-second-brain:open-chat");
    await sleep(1000);

    // Assert DOM state
    const count = obsidian('dev:dom selector="[data-type=\\"chat\\"]" total');
    expect(count).toBe("1");

    // Assert no errors
    expect(getErrors()).toBe("");
  });
});
```

## Targeting the Vault

All CLI commands automatically target the **S2B Test Vault** by placing `vault="S2B Test Vault"` before the command (see `helpers/cli.ts`). You can have other vaults open — tests will always run against the correct one.

## Manual CLI Debugging

For ad hoc UI verification outside the automated test suite, prefer this sequence:

1. Make sure the **S2B Test Vault** is already open in the Obsidian desktop app.
2. Execute a command:

   ```bash
   obsidian vault="S2B Test Vault" command id=smart-second-brain:search-notes
   ```

3. Poll until the UI is mounted instead of inspecting it immediately:

   ```bash
   obsidian vault="S2B Test Vault" dev:dom selector='.s2b-search-modal' total
   ```

4. Then inspect or capture it:

   ```bash
   obsidian vault="S2B Test Vault" dev:dom selector='.s2b-search-modal .prompt-input-container' inner
   obsidian vault="S2B Test Vault" dev:screenshot path="/tmp/search-modal.png"
   obsidian vault="S2B Test Vault" dev:errors
   ```

Notes:

- Use the vault name `S2B Test Vault`, not the repo-relative path. The CLI resolves the opened vault by name.
- Prefer `command`, `dev:dom`, `dev:screenshot`, and `dev:errors` for manual checks.
- `eval` and `dev:cdp` are more fragile and should be used only when DOM queries and screenshots are not enough.
- Some commands return before the modal/view is fully mounted, so polling for a selector is the safest pattern.
- There is an upstream Codex Desktop macOS issue where running `obsidian` from inside Codex can sometimes make Obsidian quit unexpectedly. If that starts happening, run the same `obsidian` commands in a normal terminal outside Codex and continue verification there.

## Search relevance benchmark

`search-relevance-benchmark.test.ts` measures *ranking quality* as a number
(nDCG@10 and MRR) rather than asserting individual orderings. Use it to prove a
search change improves results instead of merely altering them.

### Running it

```bash
bun run corpus:generate     # once — writes Corpus/ into the test vault
bun run build && bun run setup-vault
# open the vault in Obsidian, configure an embedding provider, let it index
bun run test:benchmark
```

The corpus is **generated, not committed** — 308 notes in `Corpus/` (285 filler,
6 core probes, 9 hard probes, 8 distractors) plus 31 of the 59 in `Zettel/`. The
generator is seeded, so it reproduces byte-for-byte; `scripts/generate-search-corpus.ts`
is the source of truth. Regenerate after changing it, then reindex.

The other 28 notes in `Zettel/` are hand-written and **are** committed — see
*Vault layout* below for why that directory is mixed.

### Vault layout

The test vault has **two content regions**, and the split is deliberate:

| region | notes | generated? | tracked in git? | role |
|---|---|---|---|---|
| `Corpus/` | 308 | yes (`scripts/generate-search-corpus.ts`) | no | synthetic bulk: 4 topic folders, ~285 near-duplicate filler notes, plus the graded probes and distractors |
| `Zettel/` | 59 | partly — 31 generated, 28 hand-written | the 28 hand-written ones | flat working vault: one person's notes, no subfolders, hierarchy via frontmatter and `[[wikilinks]]` |

`Welcome.md` stays at the vault root because it is Obsidian's landing note, not
content.

#### Filenames use spaces, not kebab-case

This is load-bearing, not a style preference. `file.basename` is indexed as
MiniSearch's **title field** (`LexicalSearchService.addDocument`), and
`SEARCH_TERM_SPLIT_REGEX` in `searchTermUtils.ts` is `/[^\p{L}\p{N}#@_-]+/u` — it
keeps `-` as a *word character*. So:

| filename | tokens |
|---|---|
| `refresh-ratios-for-daily-baking` | **1** (one opaque blob) |
| `Refresh Ratios for Daily Baking` | **5** |

A kebab-case filename can never partially match a query, so `calculateTitleBoost`
gets nothing from it.

The asymmetry cuts both ways, which is why **every note in both regions** now uses
`titleToFilename()`:

- a slugified **distractor** loses the title signal that makes it a competitor, so the
  benchmark gets quietly *easier* — this is what happened when the bulk filler was
  briefly slugified;
- a slugified **target** loses the signal that would surface it, so the benchmark gets
  *harder* for a reason nobody chose.

Neither was a deliberate property. Both were artifacts of the filename convention.

Spaces also match how Obsidian itself names notes (the filename *is* the title), and
how the hand-written fixtures in this vault have always been named.

Dashes are kept where they belong to the title — dates (`2026-03-16.md`, `Weekly
Review 2026-03-14.md`) and `1-1 with Priya - March.md`. A colon between digits becomes
a hyphen rather than being stripped, since deleting it turns `1:1` into `11`.

`slug` still exists on the note types as the generator's stable internal identifier —
used by the pair-balance guard, the size-bias shape check, the per-note PRNG seed, and
`--clean` — so display text and machinery change independently. A retitled note keeps
its PRNG stream; only its filename moves.

Two guards keep the link graph honest: every `[[wikilink]]` target must resolve to a
real note (`INTENTIONAL_STUBS` declares the one deliberate unresolved link, since real
vaults have those), and link targets are normalised through the same
`titleToFilename()` the writer uses, so links and filenames cannot drift apart by
construction rather than by discipline.

Non-ASCII titles survive intact — `Sauerteigführung im Winter.md` keeps its umlaut,
which matters because the cross-lingual axis depends on those notes being genuinely
German.

**Consolidated 2026-08-18.** `Topics/` (20 notes), `Large Notes/` (2) and six loose
root notes used to be separate regions. They were folded into `Zettel/` so the vault
reads as one place rather than five labelled zones. Nothing was rewritten — the moves
were `git mv`, the note bodies are byte-identical, and the wikilinks between them were
already bare `[[Note Name]]` references that Obsidian resolves by name, so flattening
broke none of them. Only the graded paths in `relevanceJudgments.ts` changed.

**This moved one core score, and the reason is worth knowing.** The lexical core mean
went 0.7281 → 0.7203, entirely from `smart city sensors and data platforms`
(0.839 → 0.735). That query contains the words "smart city", which used to match the
**folder name** `Topics/Smart Cities/` through `calculatePathBoost`
(`src/search/searchRanking.ts:345`). Flattened, there is no such segment, so the boost
is gone and `Urban Data Platforms.md` — a grade-2 target whose *title* shares no query
term — fell out of the top 5, while siblings with "Smart" in their titles kept their
`titleBoost`.

Nothing about the notes changed, so the honest reading is that **the old 0.839 was
partly earned by folder naming rather than by ranking quality**. A Zettelkasten vault
has no such folders, so the lower number is the more representative measurement. It is
also a concrete demonstration of how much a path segment can be worth: ~0.10 nDCG on a
single query, from a directory name.

`Corpus/` was deliberately *not* folded in. It is 308 generated notes, ~285 of them
near-duplicates of each other; dissolving that into the flat namespace would not
produce a Zettelkasten, it would produce four topic silos with the labels removed —
less realistic than the current split, while voiding every recorded baseline. The
folders are what make bulk filler plausible. The cross-vocabulary interference that
makes real search hard comes from `Zettel/` being cross-cutting (see *Why the layer
is small but weighted* below), not from where notes sit on disk.

### What it contains

`helpers/relevanceJudgments.ts` holds the judgment set: each query carries graded
expectations (`2` = answers the query, `1` = related, `0` = a distractor the
ranker is expected to be tempted by) plus a `probes` string explaining which
behaviour the case tests. Queries deliberately avoid the target note's own
wording, so term overlap alone cannot find them.

Cases cover: near-synonym bridging, lexical distractors, zero-overlap
(semantic-only) retrieval, very short and multi-chunk targets, alias matches,
multi-target queries, near-duplicate discrimination, and recency-vs-relevance
conflicts (via the `recentNotes` fixture, which the harness applies and clears
per query).

### The ratchet

`BASELINE_MEAN_NDCG` / `BASELINE_MEAN_RR` are the current best measured scores.
The suite fails if the mean drops below them, and **prints the new value when it
improves — raise the constants at that point** so progress is locked in. Lowering
them should be deliberate and explained.

Current baseline (**core tier only** — the hard tier is not ratcheted; see below):
**mean nDCG@10 = 0.9966, MRR = 1.0** (18 cases,
`openrouter:qwen/qwen3-embedding-8b`, 2026-08-16). Seventeen cases score 1.000;
the multi-target smart-city query sits at 0.938 because a grade-1 note ranks
between the two grade-2 targets, which reflects grading uncertainty in that case
rather than a demonstrated ranking defect.

Two of the cases are length-bias probes and must be kept as a pair: one where the
many-chunk note is the *wrong* answer, and one where it is genuinely right. The
first catches chunk-count inflation; the second stops a fix for it from turning
into a blanket penalty on long notes.

### The hard tier

The cases above are **saturated** — every strong embedding model scores ~1.0 on
them. That makes them a good regression guard and a useless model-comparison
tool: they cannot tell a 22M-param local model from a 600M one.

The `hard` tier exists for that second job. Cases carry `tier: "hard"` plus an
`axis`, and are built to have *headroom* along the dimensions where retrieval is
expected to lose ground — the first five where a small distilled encoder struggles,
the last three where *any* model must resolve meaning rather than topic:

| Axis | What it probes | Why a small model struggles |
|---|---|---|
| `multi-hop` | Answer requires joining two facts held in different sections | Needs compositional signal, not single-passage similarity |
| `cross-lingual` | German notes ↔ English queries (both directions) | bge-micro-v2 is English-distilled; harrier/qwen3 are multilingual |
| `long-context` | Answer buried ~900–1100 words into one heading-free section | Exceeds a 512-token window, so the answer is truncated away |
| `dilution` | Answer is one section inside a six-topic note, competing against siblings that are more obviously on-topic | Must prefer the section that *answers* over the note that is *about* the subject (the original note-level averaging premise is solved — see below) |
| `size-bias` | A long padded note out-chunks the short note that answers the query | A note's score is the max over its chunks, and max-of-N grows with N regardless of relevance |
| `polysemy` | One word, two legitimate senses, neither note off-topic | Both notes are honestly about the query's topic; only sense separates them |
| `intent-frame` | Same topic words, opposite relational role ("feedback I received" vs "gave") | Requires the *direction* of a relation, which term overlap cannot express |
| `provenance` | Query scopes by where a note came from, not what it is about | Frontmatter provenance fields are not indexed; path/tag boosts cannot fire (see below) |

#### The realistic-use axes (`polysemy`, `intent-frame`, `provenance`)

These were added after a real-vault failure the rest of the suite could not
reproduce: the query **"feedback i received"** returned notes about an LLM
feedback-scoring component in an automation pipeline, not notes recording feedback
the user was given.

Three properties of `Corpus/` made that unreproducible:

1. **Every distractor there declares its own irrelevance.** `octopus-recipes.md`
   literally contains *"not animal behaviour, learning, or any container-opening
   problem solving"*. An embedder reads that and correctly pushes the note away —
   which is why those cases saturate. Real polysemy has no such tell.
2. **The four domains are hermetic.** No shared vocabulary, so cross-domain
   confusion is trivially avoidable. Real vaults are one person's notes, where the
   colliding senses sit side by side.
3. **No query is about the user.** All the original cases are third-person factual
   lookups; real usage skews first-person and relational.

They grade against **`Zettel/`** — a flat, single-directory layer (no subfolders)
with hierarchy in frontmatter and `[[wikilinks]]`, mirroring a Zettelkasten vault.
Both of those organising mechanisms are **inert for ranking**: nothing in
`src/search/` reads link structure, and `LexicalSearchService` reads only
`aliases`/`tags` from frontmatter. That is deliberate — it is the condition under
which real-vault search fails, and the folder-shaped corpus never reproduces it.

Two mechanics worth knowing when reading these scores:

- **`i` never reaches the ranker.** `isSignificantSearchTerm` drops single-character
  tokens, so "feedback i received" plans as `feedback | received`. `received` and
  `gave` are *not* stopwords and score at full weight — but the target notes avoid
  them ("Priya said", "I told him"), as real notes do, so lexical is reduced to the
  one term both candidates share.
- **`provenance` is one case, not a full axis.**
  `calculatePathBoost` **now matches token-wise** (2026-08-18), so a conversational
  query can earn folder credit; `calculateTagBoost` deliberately still does not —
  see *Token-wise path and tag matching* below for the measurement that split them.
  The case passes anyway, and for an unrelated reason (the semantic half finds the
  notes from title and body text), which is why it is one case rather than an axis.

The suite also asserts one property no aggregate can express: **"feedback i
received" and "feedback i gave someone" must not return the same top note.** Both
can score respectably on nDCG while returning identical orderings, since each has a
graded-2 note the other ranks highly. Only comparing the two orderings catches a
ranker that keys on topic and ignores direction.

**Sub-1.0 scores here are the intended state, not failures to fix.** The tier is
gated only by `HARD_FLOOR_MEAN_NDCG`, a loose collapse guard — deliberately *not*
a ratchet. Ratcheting it would turn a measuring instrument into a second
regression gate and destroy the headroom the tier exists to provide.

Read the **per-axis** rows, not the mean. A model can look fine overall and still
be unusable for a partly-German vault; only the axis split shows that.

The long-context cases depend on note *shape*, not length: `chunkText` splits on
every heading level H1–H6, so a long structured note yields many small chunks and
never exercises a token ceiling. The generator's `unstructuredTail` builds an
unbroken run of prose specifically to defeat that.

Cross-lingual notes are monolingual German down to the filler vocabulary
(`vocabularyDe` per domain). Earlier drafts left English technical terms in German
sentences, which handed an English-only model free traction and made the axis
measure nothing.

**Cross-lingual was the lowest-scoring axis (0.5253 harrier / 0.6483 qwen3), and was
diagnosed as a model limit rather than a ranking bug.** Investigated 2026-08-18; the
evidence below is all still valid, but **the conclusion it was used to support was
overturned later the same day** — the axis reaches 0.7500 on `harrier` with no model
change, purely by re-weighting fusion. Read this list as *why the German note loses
the semantic contest*, not as *why the axis cannot be fixed*; the correction follows
it.

- The three cases behave completely differently — German→English scores 0.945, while
  `keeping a sourdough starter active in a cold kitchen` scores 0.000. There is no
  single systemic cause to fix.
- On the failing case the grading is correct and the case is fair: the German note
  directly answers it ("unheated kitchen under eighteen degrees… refresh more often
  with warmer water"), and **not one** of the 8 English `sourdough-starter-maintenance-*`
  siblings that beat it even contains the word "cold". They win on topic similarity.
- The decisive measurement is the same note against the same index in two languages:
  a **German** query puts it at **rank 1** (0.773); the **English** query puts it at
  **rank 19** (0.656). The encoder loses ~0.12 of similarity crossing languages —
  exactly enough for same-topic siblings to overtake it. `qwen3` halves the penalty
  (rank 19 → 10) but does not remove it, which is the axis discriminating between
  models as intended.
- The target is absent from lexical entirely (a German note shares no terms with an
  English query), so it enters fusion on one source. Crediting a missing source from
  the other was implemented and swept 0 → 1.5: **a dead end.** Cross-lingual nDCG
  never moved off 0.5253 at any value, while core fell 0.8889 → 0.8483 and
  long-context collapsed 0.9210 → 0.6443. On a typical query 55-72% of semantic
  results are absent from lexical, so that credit is a broad boost to the majority,
  not a targeted fix. The note's rank did improve (43 → 15) but never reached the
  top 10.

**Superseded 2026-08-18 — this axis was a ranking problem after all.** The paragraph
that stood here read: *"The lever that would actually move this axis is a more
multilingual embedding model, which is what the axis exists to reveal. Do not chase
it in the ranker."* That was measured at `SEMANTIC_SOURCE_WEIGHT = 0.78`, and it is
wrong at 0.86: raising the weight takes `cross-lingual` **0.5154 → 0.7500 with no
model change**, on the same index build.

The diagnosis above is still correct in every particular — the encoder really does
lose ~0.12 of similarity crossing languages, and the German note really is absent
from lexical. What the conclusion missed is *who was casting the deciding vote*. The
English same-topic siblings that overtake the German note do so because the **lexical**
leg prefers them (they share literal query terms; the German note shares none). At
0.78 the lexical leg had enough weight to carry that preference through fusion. The
semantic leg had the right answer the whole time and was being outvoted.

Note the earlier "credit a missing source" experiment failed for a *different* reason
and its verdict stands — that approach broadly boosted the majority of results, where
this one narrows the lexical leg's influence globally. The full weight sweep is in the
`SEMANTIC_SOURCE_WEIGHT` docblock (`src/search/finalSearchRanking.ts`).

The general lesson worth keeping: **an axis attributed to a model limit should be
re-tested against the fusion weights before it is written off**, because a weak-but-
correct semantic ranking and a confident-but-wrong lexical one are indistinguishable
from "the model cannot do this" if you only look at the fused output.

**`dilution` no longer measures dilution (2026-08-18).** It was written for a real
defect — a six-topic note whose *note-level* embedding averaged the answer away — but
retrieval is chunk-level and `chunkAggregation.ts` scores a note as
`best_chunk * (1 + support)`, so the answering chunk is now found on its own merits and
the surrounding topics cannot dilute it by construction. **A low score here is not
evidence of a chunking regression**; do not go looking in `chunkAggregation.ts` for it.

What the two cases measure now is **topical proximity vs. answerhood** — the target
answers the question while a sibling that is more obviously *about* the topic does not
(`Foundry Operations Log` over `Hinting and Rasterization`). That is nearer in shape to
`multi-hop` than to the original premise.

It is kept rather than retired for two measured reasons. It *does* still discriminate:
it looked saturated at 1.0000 while only `harrier` and `Qwen3-4B` had been measured,
but `text-embedding-3-small` scores **0.7754** — the weakest of the three on this axis
while being the strongest overall, which is exactly the disagreement-with-the-aggregate
an axis exists to surface. And the hinting case is one of two that fall 1.000 → 0.689
at `SEMANTIC_SOURCE_WEIGHT = 1.0`, so it actively constrains that constant. The axis
*name* is deliberately unchanged, since renaming it would break comparison with every
figure already recorded below.

`size-bias` is the one axis that measures the ranker more than the model, and the
only place in the suite where a many-chunk note is the **wrong** answer. Everywhere
else length is either rewarded or irrelevant — graded targets skew long (median 8
sections against a corpus median of 4) and ordinary distractors are all under 700
words. Without this axis the suite can measure the *cost* of a length penalty and
never its *benefit*, which is exactly how a measured chunk-count correction came to
look purely negative on every axis (the measured A/B is recorded in
`src/vectorstore/chunkAggregation.ts`).

Its distractors are the largest notes in the corpus and must out-chunk the short
note that answers their query — the generator asserts this, because the chunker
splits on headings, so a graded target that gains sections silently disarms the case
unless its distractor grows too.

#### The realistic-use axes, measured on lexical-only (2026-08-18)

Recorded before any embedding provider was configured, so this is the **lexical
floor** — what the ranker does with no semantic half at all. It is worth keeping
because it isolates the mechanism precisely:

```
"feedback i received"     → 1. Zettel/feedback-scoring-service.md   ← WRONG
"feedback i gave someone" → 1. Zettel/feedback-scoring-service.md   ← WRONG (same note)
```

Both directions return the same top note, and it is the wrong one for both. Term
counts explain it completely:

| note | "feedback" | "received" | "gave" |
|---|---|---|---|
| `feedback-scoring-service.md` (wrong answer) | **4** | 0 | 0 |
| `1-1-priya-2026-03.md` (answers "received") | 0 | 0 | 0 |
| `feedback-i-gave-2026-q1.md` (answers "gave") | 0 | 0 | 0 |

The lexical ranker has exactly one signal available — term frequency of `feedback` —
and it points entirely at the wrong note. This is not a tuning problem: **the notes a
person actually writes about feedback rarely contain the word.** A 1:1 note says
"Priya said"; a review-prep note says "I told him". Nothing lexical can bridge that,
which is why these cases sit in the hard tier and why the semantic half carries the
entire burden.

**The hybrid tier has since been measured** (`harrier-oss-v1-0.6b-MLX-8bit`, see
*Recording results per model* below) and the failure survives it: `feedback i
received` and `feedback i gave someone` still return the *same* top note. The semantic
half raises the core tier from 0.7110 to 0.9085, but it does not recover the
relational frame — which is why `intent-frame` is one of the two weakest axes.

**Refined 2026-08-18: the frame is recoverable in the semantic leg, but two
independent failures stack.** The embedder *does* encode direction when the query
carries enough content — for `criticism my manager gave me about my work` the
**semantic leg alone** ranks `1-1 with Priya` first (0.5778, up from 0.5007/rank 13
on the bare `feedback i received`), and `Feedback Scoring Service` leaves the top 5
entirely. So query expansion genuinely repairs the semantic half.

**It does not fix the end-to-end result, though.** On that same query the *hybrid*
top hit is still wrong — `Internal Pitch for the Platform Work`, because its title
contains "Work" and it therefore saturates the lexical leg at score 1.0. Fusion
carries that through. This is a *second*, independent defect of the same shape as
`griechischer salat`: an incidental lexical title match outvoting a correct semantic
ranking.

The consequence for planning: query expansion is necessary but **not sufficient** for
this axis. Both the query-side gap and the lexical-saturation gap have to close
before `intent-frame` moves *on a given model*.

**But the axis is also strongly model-sensitive**, which the single-model analysis
above could not see: it ranges 0.6057 (Qwen3-4B) to 0.7169 (text-embedding-3-small) at
hybrid 0.86, and reaches **0.7616** on text-embedding-3-small at semantic-only. So
"unfixable in ranking" remains true and "stuck at ~0.63" does not — swapping the
encoder moves it more than anything tried in the ranker. Full measurements under
*Recording results per model*.

#### Why the layer is small but weighted (measured 2026-08-18)

`Zettel/` is 31 notes against 308 in `Corpus/` — 8.4% of the vault — yet it takes a
far larger share of every result set, because its vocabulary cuts across the topic
corpus instead of sitting inside one silo:

| query | Zettel notes in lexical top-25, at 10 notes → at 31 |
|---|---|
| how long before a rate change reaches borrowers | 4/25 → **8/25** |
| what makes very small text readable | 4/25 → **9/25** |
| smart city sensors and data platforms | 2/25 → 2/25 |
| can an octopus learn to open a sealed jar | 1/25 → 2/25 |

Two things worth reading off this. The layer is **~4× over-represented** relative to
its size, which is the crowding real vaults produce and the topic corpus cannot. And
the domain-anchored queries (octopus, smart city) barely move — correct, since generic
working-life vocabulary should not override a strong topical match.

**The core lexical mean was 0.7281 before the expansion and 0.7281 after.** Adding 21
notes that take up to a third of some result sets changed the regression tier by
nothing: the new notes crowd results without displacing correct answers. That is the
property that makes it safe to keep growing this layer.

This is also why the layer was *grown* rather than the regions being flattened into
one namespace. Flattening was considered and rejected: a flat directory holding 77
near-duplicate typography notes is not a Zettelkasten, it is four topic silos with the
labels removed — less realistic than what is there now, while voiding every recorded
baseline and breaking the folder-spanning multi-target cases. The cross-vocabulary
interference that makes real search hard comes from the notes being cross-cutting, not
from where they sit on disk.

#### Filler notes have real titles

The bulk filler has 40 unique subjects and 285 notes to produce, so each subject
recurs about seven times. That used to render as `Kimchi Seasonality 2` through
`Kimchi Seasonality 7` — a shape no real vault has. People write several notes
circling the same idea from different angles, under different names, months apart;
they do not number them.

Each subject now carries a `variantTitles` list of distinct hand-written titles
(`Winter Kimjang Batch Notes`, `Summer Quick Kimchi Methods`, `Fermentation Speed and
Ambient Heat`), still recognisably about the same subject — that topical overlap is
the point, since two judgment cases grade these siblings at 0 to make crowding cost
score.

**Variant 1 keeps the plain subject name.** Four judgment cases grade a base note
(`Koji Cultivation`, `Variable Font Axes`, `Yield Curve Inversion`, `Hinting and
Rasterization`) at 1 as a genuinely-related result, so those must survive. It also
mirrors a real vault: one canonical note per topic, plus scattered related ones.

The numbered scheme was not just unrealistic — it made crowding *too easy to detect*.
A shared title stem is a free grouping signal, and `getNumericSuffixPenalty` in
`lexicalScoring.ts` explicitly keys on a trailing number. Real near-duplicates are
only discoverable through overlapping vocabulary, which is now the case here.

The generator throws if a subject has no `variantTitles` entry or too few titles for
the variant count `BULK_TARGET` implies, so this cannot silently regress to numbers.

#### The `griechischer salat` case (false-cognate prefix match)

Found by hand while spot-checking the vault, then added as a `cross-lingual` case.
Measured hybrid:

```
"griechischer salat" → 1. Salt Tolerance Across Species      ← wrong
                       2. Salt Type and Mineral Content      ← wrong
                       3. Salt Percentage and Aging Duration ← wrong
                       4. Cooking Mediterranean Recipes      ← correct (nDCG 0.431)
"greek salad"        → 1. Cooking Mediterranean Recipes      ← correct
```

German `salat` prefix-matches English `salt`, and those three filler notes carry
"Salt" in their **titles**, so they collect `calculateTitleBoost` on top of the term
match. The right answer has no title match at all — `## Greek Salad (Horiatiki)` is a
heading inside `Cooking Mediterranean Recipes.md` — so it competes on content score
alone. The English query returning it at rank 1 isolates the cause to the cognate
rather than to retrieval, and the lexical-only run reproduces the same three winners,
so the misdirection is lexical and the hybrid fusion carries it through.

Prefix matching is deliberate and already tuned (`prefix: shouldContentPrefixMatch`,
`weights: { prefix: 0.3 }` in `MiniSearchService.ts`), with a documented history of
exactly this class of problem — so this is not a switch to flip. The case measures
whether the semantic half can recover a query the lexical half actively misdirects.
It could not at `SEMANTIC_SOURCE_WEIGHT = 0.78`, and the case carried a `knownFailure`
annotation for that reason. **Fixed 2026-08-18 at weight 0.86** — the case now scores
**1.000** on hybrid and the annotation has been removed. Nothing about the cognate
collision changed; cutting the lexical leg's vote was enough to stop the misdirection
carrying through fusion, which is precisely the property this case exists to measure.
It stays in the suite as a live guard against the lexical weight being raised again.

Note the collision was *created* by giving the filler realistic titles: those notes
were previously `brine-concentration-N.md`, with no "Salt" in the title and therefore
no title boost. The rename did not introduce the prefix behaviour, it exposed it. The
three notes are pinned in `REQUIRED_FILLER` so renaming them cannot make the case
silently pass for the wrong reason.

#### Collision clusters

The layer is organised around **sense collisions** rather than topics. `block`,
`context`, `run`, `sync`, `draft`, `ship`, `scale`, `capacity`, `charge`, `pitch`,
`review`, `feedback` and `pipeline` each appear in at least two notes in *unrelated
senses* — calendar block vs storage block, LLM context window vs interruption context,
nightly run vs running a team.

The generator asserts this. A cluster that drops below two members throws, because a
single-member cluster silently tests nothing. That guard is not theoretical: it caught
`context-switching-cost.md`, whose first draft described the phenomenon without ever
using the word "context" ("the state I had in my head"), and `draft`, which had one
real member once frontmatter was excluded from the count.

Cases in these clusters were **measured before being written** — each query was run
against the live ranker and kept only if the correct answer did *not* already win.
Queries whose target matched by title ("the nightly run keeps failing" → rank 1) were
discarded rather than banked as easy wins, since a case with no headroom cannot
discriminate between models.

#### The phrase tier — adjacency measured, and hybrid absorbs the gap (2026-09-01)

The lexical leg is structurally phrase-blind: MiniSearch's inverted index stores term
frequencies but no positions, so a note containing "deep scattering layer" verbatim and
a note containing those three words in three unrelated sentences present identical
lexical evidence. `PHRASE_JUDGMENTS` (held out of every ratcheted tier) measures what
that costs, per retrieval leg, using three target/decoy pairs where the decoy holds
every phrase word at **equal or higher frequency**, scattered, never adjacent, with
both titles kept clean of query terms — the shape is asserted by the phrase-pair guard
in `scripts/generate-search-corpus.ts`, so prose edits cannot silently convert a case
into an ordinary TF contest.

Measured on `omlx:harrier-oss-v1-0.6b-MLX-8bit` (incremental index, notes auto-embedded
on creation):

| query (phrase) | lexical | semantic | hybrid |
|---|---|---|---|
| "where does the cold chain usually break" | rank 2 (0.631) | rank 1 | rank 1 |
| "does forward guidance actually move expectations" | rank 2 (0.631) | rank 3 (0.500) | rank 1 |
| "why does the deep scattering layer rise at night" | rank 1 | rank 1 | rank 1 |
| **mean nDCG@10** | **0.7540** | **0.8333** | **1.0000** |

Reading:

- **The structural gap is real.** In 2 of 3 cases lexical ranks the scattered-word
  decoy above the phrase-verbatim target — the decoy simply is the better bag of
  words, and no lexical tuning can change that without positional data.
- **Hybrid fully absorbs it** on this corpus and model: 1.000 / 1.000 across all
  three cases. The semantic leg understands that a note *about* the cold chain beats a
  note that merely uses both words, and fusion carries that through.
- **How lexical-2 + semantic-3 fuses to hybrid-1** (`forward guidance`, probed
  per leg): fusion rewards *consensus*, not average rank. The target is the only note
  near the top of both lists — semantic 0.983 (rank 3, just 1.7% behind the leader in
  a tightly packed set) and lexical 0.94 (rank 2). Its competitors are one-legged: the
  decoy is lexical rank 1 but **absent from the semantic top-25 entirely**
  (normalized semantic 0, so its score part is capped at `0.7 × 0.14 = 0.098`), and
  the two expectation-formation notes that beat the target semantically sit at
  lexical 0.25/0.24 (ranks 15/18). Working the formula
  (`0.7 × (0.86·sem + 0.14·lex) + 0.3 × RRF`): target ≈ 0.98, expectation notes
  ≈ 0.89, decoy ≈ 0.25. Two strong legs beat one perfect leg — which is the designed
  behaviour, and these cases turn out to demonstrate it cleanly.
- **Consequence — and note hybrid is nobody's default.** The search modal never runs
  hybrid at all (lexical by default; Tab switches to semantic-*only*, deliberately —
  see `SearchModal.activeAlgorithm`), and `search_notes` defaults to lexical with
  guidance to escalate, reaching hybrid only when the agent explicitly picks it for a
  mixed specific+fuzzy query. So the perfect hybrid row covers the *least-used* path,
  and the leg with the measured defect — lexical — is the default on both surfaces. A
  phrase-aware re-rank would therefore improve the default experience, not a corner
  case. Mitigating: the observed failure is the decoy at rank 1 with the target at
  rank 2 — one position, still on screen in the modal and still inside any
  `maxResults` the agent reads — so the decision stands as *deferred*: not built
  until phrase queries misrank by more than one position, or real-vault reports
  surface the pattern.
- Caveats: n=3, one lexical case the target won anyway (BM25's within-corpus IDF makes
  strict TF domination hard to engineer for common words), and Hole@10 is 8.3/10 — the
  queries collide with existing filler (`Forward Guidance.md` exists as a bulk-filler
  title and takes lexical rank 3 for its query) so the scores are lower bounds.

If a phrase re-rank ever ships, promote `PHRASE_JUDGMENTS` into the graded tiers so the
suite defends it; until then the block is reported, never gated.

#### Recording results per model

#### Query-side instruction for asymmetric models (2026-09-02)

`src/vectorstore/queryInstruction.ts` wraps the search query in the model family's
retrieval instruction before embedding (`Instruct: Given a web search query, retrieve
relevant passages that answer the query\nQuery: …` for Qwen3-Embedding, harrier and
gte-Qwen2; the BAAI sentence prefix for English BGE and mxbai). Documents stay raw, so
an existing index serves both arms and the A/B below is against **one** harrier build.

The failure it fixes was found on a phone vault (`openrouter:qwen/qwen3-embedding-4b`):
for `history`, two `.chat` threads and a stub note reading "Note about a random topic"
scored 0.51-0.53 while `Historical Conspiracies.md` scored 0.40 and sat at rank 9.
Content-free text sits near the centroid, and so does a bare one-word query. With the
instruction the same stored vectors gave the history note 0.385, `Ancient Egypt` 0.35 and
every chat 0.26-0.33 — the right order. A natural-sentence query ("notes about history")
made it *worse* (chats 0.68), so this is not something the user can phrase around.

Measured on `omlx:harrier-oss-v1-0.6b-MLX-8bit`, bare → instructed, paired bootstrap on
nDCG@10:

| tier | bare | instructed | δ | 95% CI |
|---|---|---|---|---|
| semantic-only core (n=14) | 0.9271 | 0.9289 | +0.002 | n.s. |
| **semantic-only hard (n=25)** | 0.7008 | **0.7983** | **+0.097** | [0.011, 0.193] ✓ |
| hybrid core (n=14) | 0.9207 | 0.8942 | −0.027 | [−0.014, 0.088] n.s. |
| hybrid hard (n=25) | 0.7903 | 0.7920 | +0.002 | n.s. |

Semantic-only hard by axis: multi-hop 0.75 → 1.00, dilution 0.79 → 1.00, size-bias
0.88 → 1.00, long-context 0.54 → 0.68, cross-lingual 0.62 → 0.73, polysemy 0.64 → 0.74;
intent-frame flat (0.68 → 0.67). `feedback i received` goes from absent to rank 3.

Three instruction sentences were swept, since the Qwen card recommends tailoring it:

| instruction | sem core | sem hard | hyb core | hyb hard |
|---|---|---|---|---|
| (bare) | 0.9271 | 0.7008 | 0.9207 | 0.7903 |
| **card default** "Given a web search query, retrieve relevant passages that answer the query" | 0.9289 | 0.7983 | 0.8942 | 0.7920 |
| "Given a question or topic, retrieve notes from a personal knowledge base that answer or cover it" | 0.9080 | 0.8179 | 0.8939 | 0.7502 |
| "Given a search query, retrieve the note that best matches it" | 0.9162 | 0.8125 | 0.8892 | 0.8076 |

Every wording costs hybrid core the same ~0.03, so that is the instruction, not the
sentence; only the card default leaves semantic core and hybrid hard untouched. The
hybrid-core loss is concentrated in one query: the instructed semantic leg ranks the
padded `Type Specimen Production Handbook` second for "what makes very small text
readable" (bare: outside the top 8), and lexical already had it first, so fusion flips
it above `Legibility at Small Sizes`. `size-bias` therefore reads 1.00 on semantic-only
and 0.75 on hybrid at the same time. `SEMANTIC_SOURCE_WEIGHT` has not been re-swept
under the instruction; with a stronger semantic leg the plateau may have moved.

The instruction A/B above was measured via a runtime patch of `semanticSearch` on the
live build, not through the vitest suite; the suite later reproduced it exactly
(semantic-only core 0.9289 / hard 0.7983) once the slot vault had an oMLX key.
`sap-hai:text-embedding-3-small` is a symmetric model and gets no prefix, so its rows
are unaffected.

##### `SEMANTIC_SOURCE_WEIGHT` re-swept under the instruction: 0.86 → 0.94

The hybrid-core cost above was the fusion share, not the instruction. With the
instruction on throughout, the full vitest suite on `harrier-oss-v1-0.6b-MLX-8bit`
against one index build:

| weight | core | hard | recency | size-bias | long-context | cross-lingual | polysemy | intent-frame |
|---|---|---|---|---|---|---|---|---|
| 0.80 | 0.8889 | 0.7725 | 0.9077 | 0.7540 | 1.0000 | 0.6577 | 0.7878 | 0.6439 |
| 0.86 | 0.8942 | 0.7892 | 0.9077 | 0.7540 | 1.0000 | 0.7500 | 0.7951 | 0.6458 |
| 0.90 | 0.8944 | 0.7897 | 0.9077 | 0.7540 | 1.0000 | 0.7500 | 0.7937 | 0.6504 |
| 0.92 | 0.9174 | 0.8037 | 1.0000 | 0.8770 | 1.0000 | 0.7500 | 0.7916 | 0.6490 |
| 0.93 | 0.9427 | 0.8177 | 1.0000 | 1.0000 | 1.0000 | 0.7500 | 0.7864 | 0.6499 |
| **0.94** | **0.9427** | **0.8204** | **1.0000** | **1.0000** | **1.0000** | 0.7500 | 0.7879 | 0.6600 |
| 0.95 | 0.9427 | 0.8117 | 1.0000 | 1.0000 | 0.8984 | 0.7500 | 0.7852 | 0.6600 |
| 0.96 | 0.9427 | 0.8020 | 1.0000 | 1.0000 | 0.8443 | 0.7500 | 0.7749 | 0.6462 |

`dilution` is 1.0000 and `multi-hop` 0.8155 at every weight. The old cliff at 0.88 is
gone because the instructed semantic leg now carries `long-context` on its own until
0.95; the padded size-bias distractor is outvoted from 0.93 up. The plateau is 0.93-0.94,
so this constant is closer to an edge than 0.86 was — re-check the table before
attributing a core move to something else. Core, hard and recency are all the highest
values recorded for harrier; the floors were raised to 0.94 / 0.94 (MRR) / 0.98
(recency). Only harrier was swept; qwen3 is unmeasured at this weight.

#### ⚠ Correction: some 2026-08-18 hard-tier figures were measured on the wrong vault

**Affected: the hard-tier totals and the `cross-lingual` axis. The ratcheted tiers are
unaffected and reproduce exactly.**

Part-way through the 2026-08-18 session the working tree was stashed and the repo moved
to `dev`. On `dev` the vault still contains `Topics/` (20 notes), `Large Notes/` (2) and
7 loose root notes *alongside* `Zettel/` — the consolidation described under *Vault
layout* exists only on `test/search-benchmark-realistic-corpus`. Measurements taken in
that window therefore ran against **29 extra notes**, which changes the within-result-set
normalization in `rankSearchResults`.

Re-measured after restoring the branch, against the **same** index build (harrier, built
14:02 — verified by timestamp, so this is not HNSW rebuild variance) and reproduced
exactly across two runs:

| tier / axis | recorded | corrected |
|---|---|---|
| core (ratcheted) | 0.9355 | **0.9355** ✓ unchanged |
| recency (ratcheted) | 0.9077 | **0.9077** ✓ unchanged |
| lexical-only | 0.7110 | **0.7110** ✓ unchanged |
| **hard — all** | 0.7872 | **0.7702** |
| **`cross-lingual`** | 0.7500 | **0.6250** |
| `intent-frame` | 0.6364 | 0.6402 |
| `polysemy` | 0.7488 | 0.7591 |
| all other axes | — | unchanged |

The whole difference is one case: **`griechischer salat` is 0.500 (rank 3), not the
1.000 that was recorded.** So the claim that `SEMANTIC_SOURCE_WEIGHT = 0.86` *fixed* that
case is wrong — it improved it from 0.431 to 0.500. Its `knownFailure` annotation stays
removed (0.500 is a real improvement over the 0.431 that justified the annotation), but
the hard tier having "zero known failures" should be read as an annotation decision, not
as evidence the case passes.

**What still holds:** the `SEMANTIC_SOURCE_WEIGHT` 0.78 → 0.86 change is unaffected on
every ratcheted tier, and `cross-lingual` still improves substantially (0.5154 → 0.6250,
+0.11 rather than +0.23). The conclusion that the axis was a fusion-weight problem rather
than a model limit is unchanged; only its magnitude was overstated.

**Re-measured:** the matrix has been re-run for `harrier` and `Qwen3-4B` on the corrected
layout — see *corrected matrix* below, which supersedes their rows. `sap-hai:
text-embedding-3-small` could **not** be re-measured (its endpoint hangs; see that
section), so its rows remain provisional and it is currently unranked against the other
two.

#### Significance and judgment holes (added 2026-08-18)

The suite now reports two diagnostics borrowed from IR-evaluation practice. Both
qualify conclusions already recorded below, so read them first.

##### Paired bootstrap — the hybrid/semantic gap is directional, not significant

`pairedBootstrapCI` (`helpers/relevanceJudgments.ts`) resamples *queries* with
replacement, 10k times, keeping each query's pair of scores together; seeded, so bounds
reproduce exactly. Measured on `harrier`:

```
core   δ=-0.0016  95% CI [-0.0235, 0.0186]  ✗ not significant   sign: hybrid 1 / semantic 1 / 12 tied
hard   δ=+0.0493  95% CI [-0.0015, 0.1038]  ✗ not significant   sign: hybrid 10 / semantic 2 / 13 tied
```

**The hard-tier hybrid advantage does not clear significance** — the interval's lower
bound is −0.0015, fractionally the wrong side of zero. With n=25 and strongly bimodal
per-query scores (mostly 0.000 or 1.000), a few queries flipping moves the mean several
points, so the interval is wide by construction.

Two claims have to be separated here, and the earlier write-up conflated them:

- **Magnitude** — "hybrid is worth ~0.05 nDCG on the hard tier" is **not** supported by
  one run.
- **Direction** — "hybrid ≥ semantic on hard" *is* well-supported: the sign test splits
  10:2 in hybrid's favour, and the sign is the same on all three embedding models. Three
  independent models agreeing is stronger evidence than any single CI.

  **Weakened by the 2026-08-20 hole-filling pass** (see below): on the same index build
  the split is now **hybrid 10 / semantic 5 / 10 tied**, from `10 / 2 / 13`. Hybrid's
  count is unchanged; three previously-tied queries broke semantic's way once the notes
  it was surfacing unscored were judged. The direction still holds — hybrid wins twice as
  many as it loses — but "10:2" should not be quoted as current.

Consequence for the `polysemy` −0.0072 recorded during the tag-boost work: that was one
case changing rank, and it is comfortably inside the noise band. It was correctly acted
on for a *mechanistic* reason (the note tagged `#review` is the wrong answer, which is a
reason independent of the score), but it should not be cited as a measured regression.

**No per-axis CIs**, deliberately: n=1..5 per axis makes an interval meaningless. Axis
rows are directional indicators, not numbers a 0.05 difference can be defended on.

##### Filling judgment holes — first pass (2026-08-19)

Three of the worst-affected queries were re-graded. **Candidates were pooled from all
three algorithms** (`lexical`, `semantic`, `hybrid`, top-10 each) rather than taken from
one ranker's output, and every added note was judged by *reading it* against the query.
Grading whatever the current ranker returns is how pooling bias gets baked in — the
point is to be willing to grade a highly-ranked note as 0.

`scripts/pool-candidates.mjs` automates the pooling half (added in the second pass):

```bash
bun scripts/pool-candidates.mjs "the review is blocking me"
```

It prints the union of the three top-10s with each note's per-algorithm rank and its
current grade, so an ungraded note sitting at rank 1 in two legs is immediately visible.
Run it with `bun`, not `node` — it imports the judgments from TypeScript so the grades it
shows cannot drift from the ones the benchmark scores. Note it queries the **live**
Obsidian instance, so the active embed index decides the semantic column; record which
build a grading pass was pooled against.

Two of the three were scoring well while a **declared size-bias distractor sat at rank 1
in both legs, ungraded**:

| query | the unpenalised note | rank |
|---|---|---|
| `which borrowers feel a policy rate change first` | `Central Bank Communications Archive` | hybrid 1, lexical 1 |
| `how long does a wet sourdough starter take to double` | `Bakery Equipment Maintenance Log` | hybrid 2, lexical 1 |

Both notes carry `distractor` + `size-bias` tags and disclaim the query in their own
body — the archive says it is *"not of how long transmission takes or which borrowers
feel a change first"*. They were simply never graded, so nDCG treated them as neutral.

The distinction the additions encode is **answerhood vs topicality**. The bulk filler
(`Sourdough Starter Maintenance`, `Currency Pegs`, `Interest Rate Corridors` …) is
same-domain template prose — *"X is a recurring topic in Y"* — that names the subject
without stating anything. Those are graded **1**: reasonable to surface, never the
answer. Notes that actively disclaim the query, or are off-topic within the domain, are
graded **0**.

**Measured effect: core 0.9355 → 0.9305, lexical Hole@10 7.4 → 7.1.** The score dropped
because previously-invisible errors are now scored; the ranker is byte-identical.
`BASELINE_MEAN_NDCG` was lowered 0.93 → 0.92 to match. **Expect this pattern to repeat**
as more holes are filled — a drop coinciding with new judgments is the benchmark getting
stricter, and should be verified against the ranking itself before being read as a
regression.

##### Filling judgment holes — second pass (2026-08-20)

The queries the first pass left outstanding, plus two the first pass had not identified.
Same method: candidates pooled from all three algorithms via
`bun scripts/pool-candidates.mjs "<query>"`, every added note judged by reading it.
**Both sides measured on the same index build** (`omlx:harrier-oss-v1-0.6b-MLX-8bit`,
built `1787061734704`), no reindex, each figure reproduced across two runs.

| tier | before | after | Hole@10 before → after |
|---|---|---|---|
| core (hybrid) | 0.9305 | **0.9245** | 7.4 → 6.8 |
| core (lexical) | 0.7100 | **0.6859** | 7.1 → 6.6 |
| hard (hybrid) | 0.7754 | **0.7836** | 8.0 → 7.4 |
| hard (semantic) | 0.7205 | **0.7343** | — |
| recency | 0.9077 | 0.9077 | unchanged |

`BASELINE_MEAN_NDCG` stays at 0.92 — 0.9245 clears it without adjustment.

**Re-measured after an Obsidian restart the same day: core 0.9237, hard 0.7809** (both
reproduced across two runs, same index build `1787061734704`, ranker byte-identical).
The whole delta is one query — `Octopus Intelligence` 0.945 → 0.933 — reordering its
graded *runners-up*; MRR is unchanged at 0.9286, so rank 1 is identical everywhere. This
is the order-dependence documented above, and it is worth knowing that it survives a
process restart on a persisted index, not just a rebuild: **treat differences below
~0.002 as noise unless MRR moves with them.**

**The hard tier went *up*, which is the opposite of the first pass.** The reason is worth
recording: the first pass added only distractors, so it could only subtract. This one
found a case where the *ranker was right and the judgments were wrong*.

`the review is blocking me` (polysemy) had `Blocked on Legal Review` at **semantic rank
1, ungraded** — a legal review that has held a contract eleven days and is blocking three
workstreams. The case had been written around three senses of "review" (code,
performance, literature) and simply missed the fourth. Grading it 0 to protect the
original premise would have been "weaken the benchmark to make it pass" run in reverse:
punishing a correct result to keep a tidy story. Graded 2 alongside the PR note, as
`what's in the pipeline` already does for its sense pair. The case moves to 1.000.

Two more declared distractors were found sitting at rank 1 while ungraded — the same
defect the first pass found twice:

| query | the unpenalised note | rank |
|---|---|---|
| `what did my manager say i should work on` | `Internal Pitch for the Platform Work` | lexical 1, hybrid 1 |
| `Octopus Intelligence` | `Octopus Husbandry Program Notes` | semantic 2 |

The pitch note is the user's *own* pitch for headcount and wins purely because its title
contains "Work"; the husbandry log carries `distractor` + `size-bias` tags and disclaims
cognition in its own body. Grading them moved their cases **down** (`what did my manager
say…` → 0.521, `feedback i gave someone` → 0.356), which is the point.

`things i said i would do and didn't` was the worst case in the suite and stays the
worst, but is now attributable. Pooled across all three algorithms it produced 17
distinct candidates and **neither graded note appeared in any of them** — the ranker
never returns `Weekly Review 2026-03-14`, whose "Did not ship:" line is the literal
answer. It scored 0.0000 for a reason nothing in the file recorded. With
`Migration Write-up - Draft` graded 1 (a genuine unmet commitment: *"Priya asked for this
and I have been avoiding it for a week"*) it now scores **0.129** — still a failure, but
one whose shape is legible.

`Levain Timing` turned up an unrelated finding: marine-biology notes take lexical ranks
2-4 on the bare word "Timing" (`Barnacle Settlement Timing`, `Spring Bloom Onset
Timing`). Cross-domain title collision on a single generic token, now graded 0 so it is
measured.

Still outstanding: `when do prices rise so fast…` (10/10 ungraded lexically) and the
`multi-hop` / `cross-lingual` cases at 9/10.

##### The reformulation tier — the fix for `intent-frame` is upstream of ranking

`intent-frame` is the weakest axis (0.6618) and **cannot be fixed in the ranker**: on
`what did my manager say i should work on` the wrong note is rank 1 in the lexical *and*
semantic legs at once, so no monotone reweighting of the two can promote the right one.
That was recorded as a dead end. It is not — it is a dead end *for the ranker*.

The `reformulation` tier tests the alternative: keep the information need and the grades
fixed, change only the phrasing. Measured on `omlx:harrier-oss-v1-0.6b-MLX-8bit`
(build `1787061734704`), hybrid:

| case | original | best reformulation | Δ |
|---|---|---|---|
| `things i said i would do and didn't` | 0.129 (rank 13) | **0.496** — `what did not ship this week` (rank 3) | +0.3670 |
| `what did my manager say i should work on` | 0.521 (rank 2) | **0.964** — `1-1 with Priya` (rank 1) | +0.4426 |
| **mean** | **0.3253** | **0.7301** | **+0.4048** |

Both reformulations follow a rule now written into the `explore-vault` skill. The first
uses the note's own vocabulary — its literal line is `Did not ship:`, which shares no
content word with the user's phrasing. The second names the participant instead of the
relation, because `my` is a stopword and `manager` appears nowhere in the target (the
note names Priya and never states her role).

**Reported, never ratcheted.** The reformulations are hand-authored, so gating on them
would reward writing easier rephrasings over improving retrieval — the same reasoning as
`HARD_FLOOR_MEAN_NDCG`. Candidates were measured with `scripts/pool-candidates.mjs`
before being written, and ones that did not move the target were discarded rather than
banked (`Priya scoping recommendation design review` leaves it absent from all three
legs).

###### Read this as a ceiling, not an expectation

The tier measures whether the corpus is **reachable**, not whether an agent will reach
it, and the gap between those is wide. These reformulations were written by someone who
had already read the target and knew its wording. An agent has not read it — that is why
it is searching — so it is guessing at vocabulary it cannot see.

How wide is visible in the cases themselves. Of four kept reformulations, **one scores
0.073, worse than its 0.129 original**; others were discarded for missing the target
entirely. A given rephrasing is closer to a coin flip than the `+0.4048` mean suggests.

That does not make retrying wrong — the downside is one wasted tool call and the upside
is a case going 0.129 → 0.496, so several varied attempts remain the right strategy, and
that is what the `explore-vault` guidance says. But two things follow:

- **Do not quote `0.3253 → 0.7301` as an expected improvement.** It is the score of a
  well-aimed rephrasing, selected with hindsight.
- **Measuring real reformulation needs a different instrument** — running the actual
  agent against these queries and scoring what it produces, rather than what a human
  who knew the answer produced. Worth building; not what this is.

This is nonetheless what motivated making `algorithm` a per-call `search_notes`
parameter: the agent can reformulate and re-run at all, and the ranker cannot.

##### Hole@10 — most of what the ranker returns is unjudged

Figures below are the **pre-second-pass** state that motivated this analysis; the current
numbers are in the table above (core hybrid 6.8, hard hybrid 7.4). The argument is
unchanged — the ratio has improved from ~2-in-10 judged to ~3-in-10, not been fixed.

```
core (hybrid)    mean 7.4/10 ungraded
core (lexical)   mean 8.1/10 ungraded
hard (hybrid)    mean 7.8/10 ungraded
hard (semantic)  mean 8.5/10 ungraded
```

**Only ~2 of every 10 returned results carry a judgment.** nDCG scores an ungraded
document exactly like one judged irrelevant, so every figure in this file is a **lower
bound**, not a verdict.

This is the pooling-bias problem BEIR documents, and this suite has it *worse*: BEIR
pools judgments from many contributing systems, whereas these are hand-written per query,
so anything the author did not anticipate is a hole by default. It compounds with a
second, self-inflicted bias — hard-tier cases were "measured before being written… kept
only if the correct answer did not already win", which is deliberate non-random sampling.

The direction of the bias matters for the hybrid/semantic question specifically. BEIR's
authors annotated 980 previously-unjudged pairs on TREC-COVID and found the *dense*
retriever had been badly understated (ANCE 0.654 → 0.735, from below BM25 to 6.7 points
above), while a lexical system moved 0.001. Ungraded-means-irrelevant systematically
punishes whichever system surfaces good-but-unanticipated notes — and semantic-only
returns the most unjudged results here (8.5/10). **So hybrid's edge over semantic may
partly be judgment coverage rather than retrieval quality.**

That does not overturn the shipped decision — the modal choice rests on the toggle-intent
argument, not on this number — but it does mean the hard-tier gap should not be quoted as
a clean measurement of hybrid's superiority.

**The second pass supplied direct evidence for this prediction.** Filling holes moved the
hard tier up for *both* algorithms, and moved semantic (0.7205 → 0.7343, +0.0138) further
than hybrid (0.7754 → 0.7836, +0.0082) — the direction BEIR reports, since semantic
returns more unjudged results and so has more to gain from judging them. The hybrid-minus-
semantic gap narrowed from **+0.0549 to +0.0493** on one pass over five queries
(95% CI [-0.0240, 0.1259], still spanning 0; sign test hybrid 10 / semantic 5 / 10 tied).
On the core tier semantic is *ahead* and widened slightly, δ=-0.0537 (sign test semantic
5 / hybrid 2 / 7 tied). Neither is significant, and with ~7 of 10 results still unjudged
the remaining holes plausibly cover the rest of the hard-tier gap.

##### 2026-11-20 — EmbeddingGemma 2 vs harrier, and what its prefixes are worth

Slot vault `S2B WT2`, 381 notes, all three indexes built the same day through oMLX.
`omlx:embeddinggemma-2-6bit` (`mlx-community/embeddinggemma-2-6bit`, 270M text
backbone, 768 dims) against `omlx:harrier-oss-v1-0.6b-MLX-8bit` (1024 dims). "raw" is
EmbeddingGemma 2 indexed and queried with its prefixes disabled, from a fresh index.

| Tier (nDCG@10 / MRR)       | EG2 + prefixes  | EG2 raw         | harrier         |
| -------------------------- | --------------- | --------------- | --------------- |
| hybrid core (n=14)         | 0.9631 / 1.0000 | 0.9421 / 0.9643 | 0.9335 / 0.9286 |
| hybrid hard (n=25)         | 0.7755 / 0.7930 | 0.7589 / 0.7621 | 0.8261 / 0.8178 |
| semantic core (n=14)       | 0.9527 / 1.0000 | 0.9498 / 0.9643 | 0.9308 / 0.9286 |
| semantic hard (n=25)       | 0.7441 / 0.7817 | 0.7109 / 0.6892 | 0.7983 / 0.8178 |
| recency (n=4)              | 1.0000          | 1.0000          | 1.0000          |

Hard-tier hybrid axes, EG2 + prefixes vs harrier: `polysemy` 0.6701 vs 0.8038,
`intent-frame` 0.6006 vs 0.6706, `long-context` 0.9075 vs 1.0000; `cross-lingual`
(0.7500), `multi-hop` (0.8155), `dilution` and `size-bias` (1.0000) tie.

Reading: the card's prefixes help EmbeddingGemma on every aggregate (semantic hard
+0.033, hybrid core +0.021), so they are worth applying. Against harrier it is a
trade, not an upgrade: slightly ahead on the core tier, clearly behind on the hard
tier, where the gap is polysemy and intent. One build per arm, no cross-model CI; at
n=14/25 only the hard-tier gap is large enough to read as more than noise. oMLX
embedded EmbeddingGemma batches in ~0.1 s against ~0.4 s for harrier, at a
quarter-smaller vector.

##### 2026-08-18 (re-measured) — corrected matrix on the consolidated layout

Re-run after restoring `test/search-benchmark-realistic-corpus`, so these supersede the
rows in the block below for `harrier` and `Qwen3-4B`. Same index builds throughout (no
reindex — the indexes were verified aligned: Corpus 308 / Zettel 59, 0 stale, all 70
graded paths resolving), consolidated `Zettel/` layout, `SEMANTIC_SOURCE_WEIGHT = 0.86`.

| model | core: hybrid | core: semantic | hard: hybrid | hard: semantic | Δ hard |
|---|---|---|---|---|---|
| `omlx:harrier-oss-v1-0.6b-MLX-8bit` | 0.9355 | 0.9930 | **0.7702** | 0.7200 | −0.050 |
| `omlx:Qwen3-Embedding-4B-4bit-DWQ` | **0.9939** | 0.9936 | **0.7548** | 0.7127 | −0.042 |
| `sap-hai:text-embedding-3-small` | — | — | — | — | **not measured** |

Per axis, hybrid @ 0.86:

| axis | harrier | Qwen3-4B |
|---|---|---|
| `cross-lingual` | **0.6250** | 0.6577 |
| `intent-frame` | **0.6402** | 0.6057 |
| `multi-hop` | **0.7500** | 0.6309 |
| `polysemy` | **0.7591** | 0.6713 |
| `size-bias` | 0.8770 | **1.0000** |
| `dilution` / `long-context` | 1.0000 | 1.0000 |
| `provenance` | 0.9871 | 0.9871 |

**`sap-hai:text-embedding-3-small` could not be re-measured.** Its embedding calls hang
indefinitely — no error, no rejection, `dev:errors` clean; a direct probe was still
pending after 45s while `omlx` models answered in ~10s. It is a SAP-internal endpoint, so
expired credentials or missing VPN is the likely cause. **Its rows in the block below were
measured on the wrong (unconsolidated) vault and remain uncorrected — treat them as
provisional.** Since it scored best overall there, the "which model is strongest" question
is currently open.

What the corrected numbers change, and what they do not:

- **Hybrid still beats semantic on the hard tier**, on both measurable models (−0.050,
  −0.042). Direction unchanged from the earlier run.
- **Neither delta is significant.** harrier hard δ=+0.0497, 95% CI [−0.0247, 0.1279];
  Qwen3 hard δ=+0.0369, CI [−0.0407, 0.1032]. As before, the *direction* is supported by
  consistency across models, not by any single interval.
- **Semantic-only still wins core**, and on harrier decisively (0.9355 → 0.9930). On
  Qwen3 the two are effectively tied (δ=+0.0003, CI [0.0000, 0.0008] — a real but
  negligible edge to hybrid, and a good example of a statistically-clean difference that
  is practically meaningless).
- **`multi-hop` moved on Qwen3**: 0.5655 → 0.6309 hybrid. Another axis whose earlier
  value was distorted by the 29 extra notes.

##### 2026-08-18 — the `semantic` algorithm, three models (⚠ measured on the wrong layout)

A third `SearchAlgorithm` was added: `semantic` — embeddings only, **no lexical leg**.
The search modal's Tab toggle now selects it (`SearchModal.activeAlgorithm`) instead of
`hybrid`; the agent's `search_notes` tool is unchanged and still defaults to hybrid.

**This is not the `SEMANTIC_SOURCE_WEIGHT = 1.0` sweep row.** Dropping the lexical leg
entirely puts `rankSearchResults` on its single-source branch, which skips RRF
rank-mixing *and* swaps `FUSION_TITLE_BOOST_MAX` (0.18) for
`SEMANTIC_ONLY_TITLE_BOOST_MAX` (0.30). The difference is large and was measured, not
assumed — on `harrier`, weight-1.0 gives hard 0.7798 while true semantic mode gives
**0.7200**.

| model | core (sem) | hard: hybrid | hard: **semantic** | Δ |
|---|---|---|---|---|
| `sap-hai:text-embedding-3-small` | 0.9835 (MRR 1.0) | **0.8166** | 0.7673 | −0.049 |
| `omlx:harrier-oss-v1-0.6b-MLX-8bit` | 0.9930 (MRR 1.0) | **0.7872** | 0.7200 | −0.067 |
| `omlx:Qwen3-Embedding-4B-4bit-DWQ` | 0.9936 (MRR 1.0) | **0.7514** | 0.7143 | −0.037 |

Per axis, semantic-only:

| axis | text-emb-3-small | harrier | Qwen3-4B |
|---|---|---|---|
| `cross-lingual` | 0.6721 | 0.6160 | 0.7083 |
| `dilution` | 0.6377 | 0.7934 | 0.8984 |
| `intent-frame` | **0.7157** | 0.6879 | 0.5201 |
| `long-context` | 0.7426 | **0.5413** | 0.8803 |
| `multi-hop` | 0.8155 | 0.8155 | 0.7500 |
| `polysemy` | 0.7659 | 0.6240 | 0.5732 |
| `size-bias` | **1.0000** | **1.0000** | **1.0000** |

**Hybrid wins the hard tier on all three models**, by 0.037–0.067. Two axes drive it:
`long-context` (harrier 1.0000 → 0.5413) and `polysemy` (0.7488 → 0.6240), both cases
where the literal query terms are what find or disambiguate the answer.

> **Qualify this with the significance section above.** A paired bootstrap on `harrier`
> puts the hard-tier delta at 95% CI [−0.0015, 0.1038] — *not* significant at n=25. The
> **direction** is well-supported (sign test 10:2, and the same sign on all three
> models); the **magnitude** is not established by one run. And with 7.8–8.5 of every
> top-10 ungraded, part of the gap may be judgment coverage rather than retrieval
> quality, since semantic-only returns the most unjudged results.

**But `core` goes the other way**, and decisively: semantic-only reaches **MRR 1.0000 on
all three models** (harrier core 0.9355 → 0.9930). Every core query returns its correct
answer at rank 1. `size-bias` also hits 1.0000 everywhere, since a padded note cannot win
on breadth-of-terms when there is no term-breadth signal.

So the two modes are genuinely different tools rather than better/worse:

- **Ordinary lookups** — semantic-only is flawless (MRR 1.0) and hybrid is not.
- **Adversarial retrieval** — hybrid is better, because the lexical leg supplies the
  literal-term signal that buried and polysemous answers depend on.

That split is what justifies exposing it as a *mode* rather than picking a winner. It
also means the earlier reasoning — that lexical's only genuine rescue was a note already
at lexical rank 1, so the leg contributes nothing after the user rejects it — holds for
the `core`-shaped queries it was derived from, and **not** for the hard tier. The modal
toggle is the right place for the choice precisely because the suite cannot know which
kind of query the user just typed.

Manual confirmation the mode is live and distinct (all three differ):

```
"griechischer salat"  lexical  → 1. Salt Tolerance Across Species     ← wrong
                      hybrid   → 1. Cooking Mediterranean Recipes     ← correct
                      semantic → 1. Sauerteigführung im Winter, 3. Cooking Mediterranean
```

Note `hybrid` now returns the right answer at rank 1 for `griechischer salat` — that is
the `SEMANTIC_SOURCE_WEIGHT` 0.78 → 0.86 change, not the new mode. Its `knownFailure`
annotation has been **removed** (the suite printed `✅ FIXED` for it), so the hard tier
now has **zero** known failures and its gated mean equals its overall mean: 0.7872 over
all 25 cases on `harrier`.

##### 2026-08-18 — three-model × two-weight matrix

All six runs below were measured back-to-back with **no reindex**: each model's index
was built once (all three hold 369 notes) and the plugin was switched between them via
`setEmbedIndex`, which is non-destructive — `harrier` reproduced 0.9355 / 0.7872
exactly after two round-trips through the other indexes, confirming the switch does not
perturb an index.

**Hard tier (nDCG@10), the model-discrimination number:**

| model | dims | hybrid 0.86 | semantic-only 1.0 |
|---|---|---|---|
| `sap-hai:text-embedding-3-small` | 1536 | **0.8166** ← best overall | 0.7918 |
| `omlx:harrier-oss-v1-0.6b-MLX-8bit` | 1024 | 0.7872 | 0.7798 |
| `omlx:Qwen3-Embedding-4B-4bit-DWQ` | 2560 | 0.7514 | 0.7336 |

**Core / recency (the ratcheted tiers):**

| model | core 0.86 | core 1.0 | recency 0.86 | recency 1.0 |
|---|---|---|---|---|
| text-embedding-3-small | 0.9819 (MRR 0.9643) | 0.9892 (MRR 1.0) | 1.0000 | 1.0000 |
| harrier-0.6b | 0.9355 (MRR 0.9286) | 0.9930 (MRR 1.0) | 0.9077 | 1.0000 |
| Qwen3-4B | **0.9939** (MRR 1.0) | 0.9939 (MRR 1.0) | 1.0000 | 1.0000 |

**Per axis at hybrid 0.86:**

| axis | text-emb-3-small | harrier-0.6b | Qwen3-4B |
|---|---|---|---|
| `cross-lingual` | 0.6992 | **0.7500** | 0.6577 |
| `intent-frame` | **0.7169** | 0.6364 | 0.6057 |
| `multi-hop` | **1.0000** | 0.7500 | 0.5655 |
| `polysemy` | **0.7980** | 0.7488 | 0.6805 |
| `size-bias` | **1.0000** | 0.8770 | **1.0000** |
| `long-context` | 0.8984 | **1.0000** | **1.0000** |
| `dilution` | 0.7754 | **1.0000** | **1.0000** |
| `provenance` | 0.9790 | 0.9871 | 0.9871 |

Four things worth reading off this.

**Hybrid beats semantic-only on all three models**, by 0.018–0.025 on the hard tier.
That is the clearest evidence yet for keeping the lexical leg at 0.86 rather than
dropping it: the result is not model-specific, and it holds for the two strongest
models as well as the weakest. Note the direction reverses on *core* for the two local
models (harrier 0.9355 → 0.9930), so the trade is real but lands on the hard axes.

**Parameter count does not predict quality here.** Qwen3-4B is the largest model and
the weakest on the hard tier (0.7514), losing badly on `multi-hop` (0.5655) and
`polysemy` (0.6805) — while topping the *core* tier at 0.9939. A model can saturate
the easy tier and still be the worst of the three at the discriminating cases, which
is precisely what the hard tier exists to expose.

**`intent-frame` is not a fixed ceiling.** It ranges 0.6057 → 0.7169 across models —
`text-embedding-3-small` scores **0.7616** on it at semantic-only, the best figure any
configuration has produced. The axis is genuinely model-sensitive, so the earlier
reading of it as "needs query expansion, full stop" is too absolute: a better encoder
moves it materially, even though the two-legs-both-wrong analysis above still explains
why *ranking* changes cannot.

**`cross-lingual` still favours the local multilingual model** (harrier 0.7500 vs
0.6992 / 0.6577), which is the axis behaving as designed.

##### 2026-08-18 (later) — `omlx:harrier-oss-v1-0.6b-MLX-8bit`, **current state**

After `SEMANTIC_SOURCE_WEIGHT` 0.78 → 0.86. This is the row to compare future runs
against; the block below it is the pre-change baseline, kept for provenance.

| tier | nDCG@10 | MRR | n |
|---|---|---|---|
| **core** (ratcheted) | **0.9355** | 0.9286 | 14 |
| **recency** (ratcheted) | **0.9077** | 0.8750 | 4 |
| hard — all | **0.7872** | 0.7846 | 25 |
| hard — gated (excl. 1 known failure) | 0.7784 | 0.7756 | 24 |
| lexical-only baseline | 0.7110 | 0.6784 | 14 |

Hard tier by axis, weakest first:

| axis | nDCG@10 | MRR | n | reading |
|---|---|---|---|---|
| `intent-frame` | **0.6364** | 0.6210 | 6 | now the weakest axis; needs query expansion, not ranking |
| `polysemy` | 0.7488 | 0.8111 | 5 | the only axis that lost anything (−0.007) |
| `cross-lingual` | 0.7500 | 0.7500 | 4 | **was 0.5154** — see the correction above |
| `multi-hop` | 0.7500 | 0.6667 | 2 | |
| `size-bias` | 0.8770 | 0.8333 | 3 | |
| `provenance` | 0.9871 | 1.0000 | 1 | |
| `dilution` | 1.0000 | 1.0000 | 2 | saturated |
| `long-context` | 1.0000 | 1.0000 | 2 | saturated |

`intent-frame` is now the weakest axis by a clear margin, which is the correct
outcome: it is the one axis whose blocker is demonstrably *not* in the ranker.

##### 2026-08-18 (earlier) — same model, pre-reweighting baseline

The first run of the hybrid tier against the reworked corpus (Zettel layer, realistic
filenames, realistic-use axes), at `SEMANTIC_SOURCE_WEIGHT = 0.78`.

| tier | nDCG@10 | MRR | n |
|---|---|---|---|
| **core** (ratcheted) | **0.9085** | 0.8929 | 14 |
| recency | 0.8155 | 0.7500 | 4 |
| hard — all | 0.7456 | 0.7297 | 25 |
| hard — gated (excl. 1 known failure) | 0.7588 | 0.7497 | 24 |
| lexical-only baseline | 0.7110 | 0.6784 | 14 |

Hard tier by axis, weakest first:

| axis | nDCG@10 | MRR | n | reading |
|---|---|---|---|---|
| `cross-lingual` | **0.5154** | 0.4375 | 4 | weakest axis; see `griechischer salat` above |
| `intent-frame` | **0.6250** | 0.6147 | 6 | the axis built for the reported failure — real headroom |
| `multi-hop` | 0.7153 | 0.6250 | 2 | |
| `polysemy` | 0.7560 | 0.8111 | 5 | |
| `size-bias` | 0.8770 | 0.8333 | 3 | |
| `provenance` | 0.9871 | 1.0000 | 1 | **higher than predicted — see below** |
| `dilution` | 1.0000 | 1.0000 | 2 | saturated |
| `long-context` | 1.0000 | 1.0000 | 2 | saturated |

> **The index build is a variance source — reindex before comparing runs.**
> These numbers reproduce *exactly* across repeated runs against the same index, but
> **not** across a rebuild of it. An earlier session on a byte-identical corpus
> (same hash `2dc3dd1e`, verified) recorded core 0.8821 / hard 0.7459 with
> `cross-lingual` 0.6077 and `size-bias` 0.7540; after the vault was reindexed, the
> same code and same notes gave the figures above. Neither set is wrong — HNSW graph
> construction is order-dependent, so two builds over identical input are not the same
> index.
>
> Practical consequence: a measured difference of a few points between two runs says
> nothing unless both ran against the same index build. When comparing embedding
> models, or before/after a ranking change, reindex once and measure both sides
> against that build. The tolerance at `BASELINE_TOLERANCE` (0.02) absorbs provider
> jitter, not this — the `size-bias` axis moved 0.12 across builds.

Three things worth reading off this:

**Core clears the 0.88 ratchet at 0.9085.** The layout consolidation and the filename
rework cost nothing on the regression tier, despite the `Topics/Smart Cities/` path
boost disappearing (a dip was anticipated at `BASELINE_MEAN_NDCG`; it did not
materialise on the hybrid tier).

**`intent-frame` and `cross-lingual` are the two weakest axes**, which is the intended
outcome — those are the ones built to have headroom. The reported real-vault failure
still reproduces on hybrid: `feedback i received` and `feedback i gave someone` return
the *same* top note (`Feedback Scoring Service`), so the direction-sensitivity
assertion fails. The semantic half does not fix it.

> Superseded: `cross-lingual` reaches 0.7500 at `SEMANTIC_SOURCE_WEIGHT = 0.86` —
> it was a fusion-weight problem, not a headroom-by-design one. `intent-frame` is
> now the weakest axis on its own. See the *current state* block above.

**`provenance` scored 0.9871, not ~0 as predicted.** The prediction — that path and tag
boosts cannot fire for conversational queries — was correct about the mechanism and
wrong about the outcome. The case returns both grade-2 notes at ranks 1-2 and the
grade-1 note at rank 4, because the semantic half finds them from title and body text
without needing the provenance signal.

The `knownFailure` annotation has been removed: labelling a passing case as broken is
worse than having no case. What it now measures is narrower but honest — provenance-
scoped queries are answerable *when the source words also appear in the text*. A query
whose provenance exists **only** in frontmatter (`type: meeting` with no "meeting"
anywhere in the body) would be the real test of the gap, and the corpus does not have
one yet. That is the obvious next case for this axis.

##### 2026-08-18 — ranking work against the weakest axes

Four changes were attempted against the `intent-frame`, `cross-lingual` and
`provenance` gaps. **Two shipped, one was measured and reverted, one was closed as
out of scope.** All figures below were measured on the *same* index build — the vault
was not reindexed at any point, and the before-side reproduced core 0.9085 / hard
0.7456 / recency 0.8155 exactly before any code changed, which is what makes the
comparison meaningful (see the reindex warning).

| tier / axis | before | after | change |
|---|---|---|---|
| **core** (ratcheted) | 0.9085 | **0.9355** | **+0.0270** |
| **recency** (ratcheted) | 0.8155 | **0.9077** | **+0.0922** |
| lexical-only | 0.7110 | 0.7110 | — |
| **hard — all** | 0.7456 | **0.7872** | **+0.0416** |
| **`cross-lingual`** | 0.5154 | **0.7500** | **+0.2346** |
| `multi-hop` | 0.7153 | **0.7500** | +0.0347 |
| `intent-frame` | 0.6250 | **0.6364** | +0.0114 |
| `polysemy` | 0.7560 | 0.7488 | −0.0072 |
| `size-bias` | 0.8770 | 0.8770 | — |
| `long-context` | 1.0000 | 1.0000 | — |
| `dilution` | 1.0000 | 1.0000 | — |
| `provenance` | 0.9871 | 0.9871 | — |

Essentially all of this comes from **one line**: `SEMANTIC_SOURCE_WEIGHT` 0.78 → 0.86.
`polysemy` gives up 0.007, which is the only cost anywhere.

Ratchets raised accordingly: `BASELINE_MEAN_NDCG` 0.88 → 0.93, `BASELINE_MEAN_RR`
0.85 → 0.90, `RECENCY_FLOOR_MEAN_NDCG` 0.80 → 0.88.

###### Lexical was over-weighted — found by user observation, not by the benchmark

Worth recording how this was found, because the benchmark did **not** surface it. The
prompt that opened this work stated `cross-lingual` was a model limit (the README said
so) and pointed at `intent-frame` as the target. Both framings came from measurements
taken at 0.78, and both were distorted by it.

What exposed it was a user noticing that the search modal returned a lexically-matched
note at rank 1 for a query where the semantic leg had ranked the right answer first —
i.e. *"when the user actively decides to do semantic search, lexical matches still have
too much weight."* That is exactly what the sweep then confirmed. See the
`SEMANTIC_SOURCE_WEIGHT` docblock for the full table and the shape of the plateau.

Note there is no "semantic-only" mode to defer to: `SearchAlgorithm` is
`"lexical" | "hybrid"` (`src/types/plugin.ts`), and the search modal does not expose
it as a choice at all — `SearchModal.ts` derives it as `semanticEnabled ? "hybrid" :
"lexical"`. (The dropdown in `ToolConfigForm.svelte` sets it for the *agent's*
`search_notes` tool, not the modal.) So enabling semantic search is a binary switch,
and `SEMANTIC_SOURCE_WEIGHT` is the *only* control over how much the lexical leg still
counts once it is on. That is what makes this constant worth getting right rather than
leaving at a value tuned against an older corpus.

###### The suite cannot score the semantic-toggle *intent* — read aggregates with care

`semanticEnabled` starts `false` and resets to `false` on every open
(`SearchModal.ts`), so the real flow is: the user types, sees **lexical** results,
decides they are not what they wanted, and toggles semantic on. There is even a
`semanticOneShotQuery` capturing the query at toggle time. In other words, by the time
the semantic leg runs, *the user has already rejected the lexical ordering*.

**No case in this suite can express that.** Every query is judged cold, with no notion
of "these results were already shown and dismissed". That matters for how the numbers
below are read: pure semantic (weight 1.0) and the shipped 0.86 score almost the same
on the hard tier (0.7798 vs 0.7872) **while failing on different queries** — so
aggregate parity is *not* evidence that the two behave equivalently in use.

Measured at weight 1.0, for whoever picks this up:

| tier / axis | 0.86 | 1.0 |
|---|---|---|
| core | 0.9355 | **0.9930** (MRR **1.0000**) |
| recency | 0.9077 | **1.0000** |
| hard overall | **0.7872** | 0.7798 |
| `intent-frame` | 0.6364 | **0.6911** |
| `size-bias` | 0.8770 | **1.0000** |
| `griechischer salat` (knownFailure) | 0.431 | **1.000** ✅ |
| `long-context` | **1.0000** | 0.8984 |
| `dilution` | **1.0000** | 0.8443 |
| `polysemy` | **0.7488** | 0.6751 |

Two things worth knowing before acting on this:

- **The regressions are not recall.** All three regressing targets are still retrieved
  by the semantic leg at ranks 1, 2 and 2 — they merely lose the *tiebreak* to a
  distractor. A "retrieve with lexical, rank without it" variant was considered on the
  assumption that lexical was supplying missing notes; the measurement above shows it
  is not, so that variant would change nothing.
- Which means every remaining loss at 1.0 is lexical acting as a tiebreaker among
  notes semantic already found — i.e. exactly the vote the user dismissed by toggling.

0.86 is shipped rather than 1.0 because these figures are `harrier`-only, and because
the `long-context`/`dilution` cost is the mechanism those axes exist to measure. But
the case for 1.0 in the *modal specifically* is a judgement about user intent that the
benchmark is structurally unable to settle — not a question more tuning will answer.

###### Token-wise path and tag matching — shipped for paths, reverted for tags

`calculatePathBoost` and `calculateTagBoost` compared the **whole query string**
against a segment or tag, so both returned 0 for any conversational query. Both were
made token-wise, with overlap scored as `min(query coverage, target coverage)`,
stopwords excluded from both sides, and the result capped at 35% of the whole-query
boost.

Paths: **no measured effect on any tier.** The capability is real and verified live
(`what is monetary policy doing to rates` now yields `pathBoost = 6.125` against the
`Monetary Policy/` folder, previously 0), but nothing in the graded set depends on
folder names — `Corpus/` is the only folder-shaped region and its queries already win
on content. Kept because it closes a genuine gap for real vaults at zero measured
cost, not because the benchmark rewards it.

Tags: **measured as a net loss and reverted.** Hard fell 0.7456 → 0.7375, entirely
from `polysemy` 0.7560 → 0.7154. The failing case is `the review is blocking me`:

| note | tags | correct? |
|---|---|---|
| `Weekly Review 2026-03-14` | `zettel`, `review` | no |
| `PR Review Backlog` | `zettel`, `platform` | **yes** |

The note tagged `#review` is the wrong answer. Tags record what a note *is*, while a
query naming a topic often wants a note *about* it — so precisely on the queries where
senses collide, tag identity points away from the answer. Halving the share
(0.35 → 0.15) did not recover the case: the boost was widening a lead the wrong note
already held lexically (base 24 vs 21.5), not creating one. Paths do not share the
defect because a folder is a *location*, not a claim about word sense.

###### `intent-frame` — not fixable in ranking; needs query understanding

Investigated and closed. The measurements:

- **The wrong note wins both retrieval legs at once.** For `feedback i received`,
  `Feedback Scoring Service` is **rank 1 in lexical *and* rank 1 in semantic**, while
  both correct answers are **absent from lexical entirely** (not in the top 50) and sit
  at semantic ranks 7 and 13. No monotone reweighting of two sources can promote a note
  that loses on both — this rules out the entire fusion-tuning family, including the
  `SEMANTIC_SOURCE_WEIGHT` lever that fixed `size-bias`.
- **The embedder is not actually blind to relational direction.** Given a query with
  enough content it resolves the frame correctly — **in the semantic leg**. These are
  raw `semanticSearch` results, *not* what the search modal shows:

  | query | semantic-leg top result |
  |---|---|
  | `feedback i received` | `Feedback Scoring Service` ✗ |
  | `criticism my manager gave me about my work` | `1-1 with Priya - March` ✓ (rank 1, 0.5778; service note out of the top 5) |
  | `feedback i gave to my report` | `Notes Before Review Season` ✓ (rank 3, ahead of the received-note) |

  So the diagnosis in the axis description is *too pessimistic*. The failure is not
  "direction cannot be represented" but **single-term topical dominance in short
  queries**: any query containing the literal word `feedback` puts the service note at
  rank 1 with cosine ~0.61, and two or three remaining words cannot outvote it.
- **But the hybrid result for the expanded query is still wrong, for an unrelated
  reason.** Measured end-to-end on `criticism my manager gave me about my work`:

  | leg | rank 1 | note |
  |---|---|---|
  | semantic | `1-1 with Priya - March` (0.5778) | correct |
  | lexical | `Internal Pitch for the Platform Work` (**1.000**, saturated) | title contains "Work" |
  | **hybrid** | `Internal Pitch for the Platform Work` (0.955) | **wrong** |

  An incidental title match on a common word saturates the lexical leg and fusion
  carries it to rank 1 — the same shape as `griechischer salat`. Query expansion is
  therefore **necessary but not sufficient** for this axis: the lexical-saturation
  defect has to close too.
- **The wrong note wins at a weak absolute score.** Its cosine is 0.61 on these
  queries, against 0.74 when it is genuinely the right answer and 0.55 when it is
  correctly mid-pack. It is the best of a bad field, not a confident match — the
  correct answers sit at 0.50–0.52.

The lever that would move this axis is **query expansion / rewriting upstream of
retrieval** (the measurements above are effectively a manual demonstration of it
working), not a ranking signal. Frontmatter `type:` was considered as a
"personal note vs project note" discriminator and rejected: `type: project` is a
graded-**2** correct answer for `what's in the pipeline`, so a type-based penalty
would fit this fixture rather than fix the ranker.

The direction check in `search-relevance-benchmark.test.ts` therefore still prints
`⚠ NOT DISTINGUISHED`, and its `expect` stays off. Turning it on would assert a
property nothing in the current pipeline can deliver.

##### Earlier runs — different corpus, not comparable

| Model | core nDCG@10 | hard: multi-hop | cross-lingual | long-context | dilution | size-bias | hard overall |
|---|---|---|---|---|---|---|---|
| `openrouter:qwen/qwen3-embedding-8b` | 0.9959 | 1.0000 | 0.6483 | 0.7057 | 1.0000 | 1.0000 | 0.8630 |
| `omlx:harrier-oss-v1-0.6b-MLX-8bit` | 0.8889 | 0.8155 | 0.5253 | 0.9210 | 1.0000 | 0.7540 | 0.7759 |

**Do not compare these rows against the block above.** They predate the Zettel layer,
the flat-vault consolidation, the filename rework, and the three realistic-use axes —
the corpus is materially different, so a difference between the two blocks says
nothing about the ranker. `qwen3` has not been re-measured on the current corpus; when
it is, it belongs in its own dated block.

`provenance` has no column in the older table: it is a single `knownFailure` case and
is excluded from the gated mean by design (see above).

**Measured 2026-08-17, after the hybrid re-weighting** (`SEMANTIC_SOURCE_WEIGHT`
0.60 → 0.78, see `src/search/finalSearchRanking.ts`). Three of the size-bias queries
deliberately restate `core` / `recency` queries verbatim, so a padded note that beats
the real answer is penalised in all three tiers at once — which is why fixing it moved
every tier:

| tier / axis | harrier before → after | qwen3 before → after |
|---|---|---|
| core | 0.8300 → **0.8889** | 0.8871 → **0.9959** |
| recency | 0.7232 → **0.8155** | 0.8155 → **1.0000** |
| hard overall | 0.7504 → **0.7759** | 0.8146 → **0.8630** |
| size-bias | 0.6309 → **0.7540** | 0.7540 → **1.0000** |
| long-context | 0.9254 → 0.9210 | 0.9410 → 0.7057 |

The `long-context` regression is the deliberate half of the trade: those answers sit
in an unbroken prose run whose embedding is diluted, so lexical is what retrieves
them, and down-weighting lexical costs recall there. It is 2 cases against the 20 that
improved. Dropping the lexical leg altogether was measured too and is far worse —
`long-context` falls to 0.2372.

`harrier` still trails `qwen3` on size-bias (0.7540 vs a perfect 1.0000), which is the
tier doing its job: the same ranker, and the weaker model still loses some
padded-note contests.

#### The precision and recall floors

Two count-based tests sit outside the graded tiers, because nDCG needs a target to rank
and these queries either have none or have one no grader assigned:

- `reports how many results a meaningless query returns` — **reported, not asserted.**
- `still returns results for meaningful queries with no lexical overlap` — **asserted.**

Semantic search has no concept of "no answer": every query embeds to some vector and
returns its nearest neighbours, so gibberish comes back with a full page (25/25) at
cosine 0.515–0.597 against 0.665–0.700 for genuine matches. Three suppressions were
implemented and measured, and **all three fail**:

| approach | why it fails |
|---|---|
| absolute cosine threshold | bands overlap; `similarityThreshold`'s 0.7 default discards real answers |
| lexical corroboration (suppress when no note shares a term) | discards `Zwiebelkuchen`, `Hefeteig` — real German queries whose answer is the German note, matching zero English-tokenised terms |
| semantic distribution shape (`top / median`) | clean on `harrier` (noise ≤1.107, real ≥1.303) but **inverted** on `qwen3`: `Zwiebelkuchen` scores 1.031 while four gibberish queries score higher, up to 1.113 |

The third is the trap worth remembering: it looked like a clean two-signal fix and
swept to an error-free band of 1.11–1.21 *on one model*. Only the second model showed
the bands overlap, so no threshold exists there at all.

The accepted trade-off is that a meaningless query returns ranked noise — the user sees
obviously-irrelevant notes and refines — rather than a real query silently returning
nothing. Any future attempt must drive the no-match count down **without** breaking the
recall floor, on both models. See `hybridSearch` in `src/agent/tools/searchNotes.ts`.
| `local-spike:TaylorAI/bge-micro-v2` | **0.8600** | 0.6445 | **0.2103** | 0.6460 | 0.9664 | — | **0.5716** |

**bge-micro-v2 (2026-08-17, 22M params, 384 dims, 512-token window, local WASM).**
The hard tier did its job: where the core tier separates the models by ~0.14, the
hard tier separates them by far more, and the per-axis split says *why*.

- **cross-lingual 0.2103 — the disqualifier.** All three cases fail almost totally.
  On "keeping a sourdough starter active in a cold kitchen" the German note is not
  retrieved at all (nDCG 0.000, rank —); the top 5 are English `sourdough-starter-maintenance-*`
  siblings. The reverse direction (German query → English note) is just as bad
  (0.000, rank 15). This is the predicted consequence of an English-distilled model
  and it is not a tuning problem.
- **long-context 0.6460 and multi-hop 0.6445** — middling, as expected for a 512-token
  window and a small distilled encoder.
- **dilution 0.9664** — genuinely strong; chunk-level retrieval carries it.
- **core 0.8600** is below the 0.99 ratchet, so the suite fails on this model. That
  is the ratchet working, *not* a ranking regression: two core cases collapse
  ("what makes very small text readable" 0.356, "when do prices rise so fast…" 0.000),
  both zero-lexical-overlap / very-short-note probes.

#### Throughput (measured, identical 32-chunk workload, warm-up discarded)

| Model | Where it runs | ms/chunk (3 runs) | chunks/s | dims |
|---|---|---|---|---|
| `harrier-oss-v1-0.6b-MLX-8bit` | oMLX, local GPU (Metal) | 53.6 / 50.6 / 50.5 | **19.4** | 1024 |
| `qwen/qwen3-embedding-8b` | OpenRouter, remote GPU | 89.3 | 11.2 | 4096 |
| `TaylorAI/bge-micro-v2` | transformers.js, local WASM | 119.8 / 121.5 / 118.3 | **8.3** | 384 |

**The 22M-parameter local model is the slowest of the three.** It loses 2.4x to a
600M model on the same Mac and 1.3x to an 8B model over the network. Parameter
count is not what decides this — parallelism is:

- bge-micro-v2 runs **strictly serial on one core**: `crossOriginIsolated` is
  `false` in Obsidian's renderer, so threaded WASM is unavailable and 11 of 12
  cores sit idle. WebGPU is available but showed no gain (dispatch overhead
  exceeds the compute saving at this model size).
- oMLX uses the Mac's GPU via Metal and batches the whole request.
- The remote call amortises one network round trip across the batch.

A bundled local model therefore buys **privacy, offline capability, and zero
setup — not speed**. For reference, a full clean vault rebuild was 2533 chunks in
211 s.

Caveat on comparability: this run indexed 2533 chunks / 343 notes, and the vault
contained extra non-corpus notes (`TaskNotes/`, `Large Notes/`, `Topics/`) that
appear in several top-5 lists. The two remote models above were measured on the
same corpus but not necessarily the same surrounding vault, so treat the core-tier
gap as indicative rather than exact.

> **Layout note (2026-08-18):** `Large Notes/` and `Topics/` no longer exist — they
> were consolidated into the flat `Zettel/` namespace along with the loose root
> notes (see *Vault layout* below). The paths above are kept as written because they
> describe the vault as it was when those numbers were measured. Graded paths in
> `relevanceJudgments.ts` were rewritten to match the new layout; the notes and their
> content are unchanged, so the scores remain comparable.

Fill the hard columns as each model is measured; the suite prints exactly these
rows. The core column is the existing ratchet and should stay ~0.99 for every
model — if it moves, that is a ranking regression, not a model difference.

### Adding a case

Append to `RELEVANCE_JUDGMENTS`. Prefer cases the ranker currently *fails* —
those are what justify a change. If one is a known failure, set `knownFailure`
with the measured evidence; the suite reports it separately instead of going red,
and tells you when it starts passing.

For a model-discrimination case, set `tier: "hard"` and an `axis` instead; it is
then excluded from the core ratchet automatically and reported under its axis.

Skips cleanly when no embedding provider is configured, so CI stays green.

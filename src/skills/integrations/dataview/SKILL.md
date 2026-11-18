---
name: dataview
description: Query the vault by its structure through the Dataview plugin — tags, frontmatter properties, folders, dates, links, tasks. Load this whenever the user asks for a category of notes ("my meeting notes", "books rated above 3", "everything tagged #project"), for notes filtered by a property or date, or for counts, totals, or groupings across notes; one DQL query answers those in a compact table where search plus many reads would not. Not for questions about what notes say — that stays with search_notes. Requires the Dataview plugin and the exec_dataview tool.
license: MIT
compatibility: Requires Dataview plugin to be installed and enabled in Obsidian
metadata:
  author: "S2B"
  version: "1.5"
  linkedPlugin: "dataview"
---

# Dataview Integration

## When to reach for it

Dataview indexes the vault's *structure*: tags, frontmatter properties, folders, file dates,
links, and tasks. Use it, instead of `search_notes` and a series of `read_content` calls, when
the question is about which notes exist or how they add up:

- a category of notes ("my meeting notes", "all books", "notes tagged #idea from last month");
- notes filtered or sorted by a property, tag, folder, or date;
- counts, totals, averages, or groupings across notes ("how many meetings in March", "tasks per
  project").

One query returns the answer as a compact table with just the fields you asked for, which costs a
fraction of the context that scanning notes one by one would. Take tag, property and folder
names from the `# Vault` section of your instructions rather than guessing them; call
`get_all_tags` or `get_properties` only when the name you need isn't there (the lists are capped).

Do **not** use it for questions about what notes *say* — Dataview does not see prose, so "what
did I write about X" stays with `search_notes`. A common shape is both: find the candidate notes
with Dataview, then `read_content` the few that matter.

## How it works

You script Dataview through its public JavaScript `api` object. When the Dataview integration is
enabled you have an `exec_dataview` tool (check your available tools) that runs JavaScript against
that `api` on the main thread — the same API `dataviewjs` blocks use.

Two ways to get results:

- **Run DQL through the API** — pass a DQL string to `api.tryQueryMarkdown(query)` for the classic
  `LIST` / `TABLE` output as Markdown. Best for straightforward tables and lists.
- **Programmatic queries** — call `api.pages(...)` and friends directly for aggregation, custom
  filtering, or statistics DQL can't express.

To *show* the user a live, auto-updating view (rather than compute over results), write a
```dataview code fence directly in your reply — see [Displaying Lists/Tables](#displaying-liststables)
below. That renders natively and does not need the `exec_dataview` tool.

## Result Size

**Showing notes to the user** ("what are my X notes", "list all my books"): answer with a
```dataview fence in your reply (see [Displaying Lists/Tables](#displaying-liststables)). It renders
the complete, live list for the user and costs you no context, so do not run the query with
`exec_dataview` first just to show it. Add a `LIMIT` only when the user asked for a few, or for a
large set: when it could be large (a common tag, a whole folder), count it first
(`api.pages(...).length`), and above about 100 notes show the first 100 with `LIMIT 100`, since
Dataview has no paging and a longer list is slow to render. Say how many there are in total and
offer to narrow it (by folder, a property, or a date). "All" does not lift this cap; the offer to
narrow does that.

**Check a filter before you show it.** The fence renders for the user only; you never see what it
returned. So when the query filters (a property value, a date range), first run the same filter
with `exec_dataview` and return only the count. If it is 0, the query is usually wrong, not the
vault empty: find out why before answering.

- **Dates:** filter on the date property these notes actually carry, not a guessed `date`. Look at
  the set: `api.pages("#tag").slice(0, 5).map(p => Object.keys(p.file.frontmatter))` shows which
  keys they use (task-style notes often use `scheduled` or `due`). Fall back to `file.day` (a date
  in the file name) or `file.ctime` only when no property holds the date, and say which one you used.
- **Your own files:** your skills and memories are notes too, and a tag mentioned in them matches.
  Exclude the folder that holds them (the parent of your memory folder) with `AND !"<folder>"`.

**Results you need to work with yourself**: when the set could be large (a whole folder, a common
tag), get the count first (`api.pages(...).length`) and fetch only what you need, slicing for
pages (`api.pages(...).slice(offset, offset + limit)`). Whenever you cap a result, say how many
notes there are in total; never present the first few as the whole set, and never re-list the same
notes with another tool to get the rest.

The limit does **not** apply to aggregation. A `GROUP BY`, a count, or a sum is only correct over the whole result set — cutting it at ten groups gives a wrong answer, not a shorter one. Run those without a `LIMIT`, or use `api.pages(...)` and aggregate in JavaScript when the number of groups could be large; return only the aggregate, never the underlying rows.

## Dataview DQL Cheat Sheet

DQL is the query language you pass to `api.tryQueryMarkdown(...)` (and the language of ```dataview fences):

- Query types: `LIST` or `TABLE field1, field2`
- FROM sources: `#tag`, `"Folder"`, `"path/to/file"`
- Exclusions: `AND !#tag`, `AND !"Folder"`
- Note: Tag/folder exclusions belong in `FROM`, not `WHERE`. For `WHERE`, use expressions like `!contains(file.tags, "#Template")`.
- Combine: `A AND B`, `A OR B`
- WHERE: `WHERE prop` (exists), `WHERE prop = "value"`, `WHERE numProp > 3`
- SORT: `SORT field asc|desc`
- GROUP BY: `GROUP BY prop` then use `rows` (e.g., `rows.file.name`)
- FLATTEN: `FLATTEN multiProp`
- LIMIT: `LIMIT n`, only when the user asked for a few or you are sampling a large set
- Display helper: `choice(boolProp, "Yes", "No") as "Label"`

## Minimal Example

```dataview
TABLE Title, Author
FROM #library AND !"Templates"
WHERE Rating > 3
SORT file.mtime desc
```

## Data Analysis

If you need to SEE the results to answer a question or perform analysis, run the query with the
`exec_dataview` tool: `return await api.tryQueryMarkdown('LIST FROM "Projects"')` for DQL, or use
`api.pages(...)` for programmatic aggregation. To only show the user a list, use a fence instead
(see Result Size above).

## Scripting the Dataview API (advanced)

Because this skill is enabled and the Dataview plugin exposes a public API, you likely also have
an `exec_dataview` tool (check your available tools) that runs JavaScript against Dataview's `api`
object (the same API `dataviewjs` blocks use) on the main thread. Use it for anything DQL can't
express — aggregation, custom filtering, computing statistics across pages.

### What's in scope

- `api` — the Dataview API object (`app.plugins.plugins["dataview"].api`).
- `app` — the Obsidian `App` instance.
- `input` — optional JSON you pass to the tool.
- `return` the final value you want back (objects/arrays are stringified for you).

### Introspect first

Prefer the documented helpers below (`api.pages(...)`, `api.page(...)`), but when you reach past
them, confirm a member exists before you rely on it — the API surface varies across plugin versions.

```javascript
// What top-level members does the API expose?
return Object.keys(api);
```

Once you know the shape, call the real methods. If a call throws, the error is returned to you as
a string — read it, adjust, and retry with a corrected call.

```javascript
// Count pages per status under a folder
const pages = api.pages('"Projects"');
const byStatus = {};
for (const p of pages) byStatus[p.status ?? "none"] = (byStatus[p.status ?? "none"] ?? 0) + 1;
return byStatus;
```

### Rules & constraints

- **Use `api.tryQueryMarkdown(dql)` for simple tables/lists**; reach for `api.pages(...)` and raw
  JavaScript only when you need programmatic logic DQL can't express.
- **Read-only by default.** Only perform mutations when the user explicitly asked to change data.
- **Not sandboxed.** This runs on the main thread with full `app` access — a call can do anything
  the plugin can. Keep snippets small and focused.
- **Awaited work times out.** Long-running or hanging promises are cut off; a runaway synchronous
  loop cannot be preempted, so avoid unbounded loops.
- **Prefer `read_content` / `manage_notes` / `search_notes` for plain note reads and writes.**
  Those tools respect the user's privacy rules — they skip or redact notes marked private for the
  current provider. `api` and `app` do not. Reach for `exec_dataview` only for query/aggregation
  logic Dataview's API uniquely provides.
- **Report honestly.** If the API can't do what the user asked, say so rather than fabricating a method.

## Displaying Lists/Tables

If you want to SHOW the user a list or table (e.g. 'List all my books'), simply output the Dataview DQL query in a markdown code block. The chat interface will render the result automatically.

- Do NOT repeat the rendered results in plain text.
- Do NOT tell the user to run the query in a note; it has already been run and rendered here.
- When generating a view, introduce it as "Here is the list:" or "I have generated the view below:".

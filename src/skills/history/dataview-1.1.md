---
name: dataview
description: Script the Dataview plugin via its public JavaScript API to query and analyze notes — tables, lists, aggregation, and DQL run through the API. Use when the user needs data from vault metadata/frontmatter and you have an exec_dataview tool. Requires Dataview plugin.
license: MIT
compatibility: Requires Dataview plugin to be installed and enabled in Obsidian
metadata:
  author: "S2B"
  version: "1.1"
  linkedPlugin: "dataview"
---

# Dataview Integration

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

## Default Result Size

Always include `LIMIT 10` in Dataview DQL (queries you show or run) unless the user asks for more or specifies a different limit.
If you need pagination or offsets, slice the pages array (e.g., `api.pages(...).slice(offset, offset + limit)`).

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
- LIMIT: `LIMIT 10` (default) or user-specified
- Display helper: `choice(boolProp, "Yes", "No") as "Label"`

## Minimal Example

```dataview
TABLE Title, Author
FROM #library AND !"Templates"
WHERE Rating > 3
SORT file.mtime desc
LIMIT 10
```

## Data Analysis

If you need to SEE the results to answer a question or perform analysis, run the query with the
`exec_dataview` tool: `return await api.tryQueryMarkdown('LIST FROM "Projects" LIMIT 10')` for DQL,
or use `api.pages(...)` for programmatic aggregation.

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

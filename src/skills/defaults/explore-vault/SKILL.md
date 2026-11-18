---
name: explore-vault
description: Search and read the user's vault for what notes say — keyword and semantic search, grep, reading notes, and counting or computing across them. Load this before searching note content, or when the `# Vault` section doesn't tell you where the notes the user means live; it holds the search procedure and what to do when a search comes back weak (reformulate, escalate the algorithm once). Not needed just to list the notes in a folder or with a tag shown in the `# Vault` section.
allowed-tools: search_notes list_directory read_content grep_notes get_all_tags get_properties execute_javascript
metadata:
  author: "S2B"
  version: "1.3"
  category: "core"
---

## Finding Notes
1. **Unknown Organization**: If the user asks for a category of notes (e.g. "daily notes", "meetings", "books", "ideas") and you don't know how they are organized:
   - If a `dataview` skill is listed in your available skills, load it: a category of notes, a filter by tag/property/date, or a count across notes is one Dataview query returning a compact table, where search plus many reads is not. Still verify the tag and property names below first.
   - Check the `# Vault` section of your instructions FIRST. It lists the vault's folders, tags and properties, so a relevant tag (e.g. #daily, #meeting, #book), property (e.g. "type", "category", "status") or folder is usually already in front of you — no tool call needed.
   - Call the tools only for what the section does not tell you: `get_all_tags`, or `get_properties` with 'note_name' omitted, when a list says entries were left out or the section is missing; `list_directory` with a folder's path when you need that folder's contents. Never walk the tree to find a note — that is what `search_notes` and `grep_notes` are for.
   - If you find a matching tag, property or folder, use it to filter your search or query.
   - If no relevant tag or property is found, call `search_notes` with a broad term to find example files and see their paths/names/properties.
   - **Do NOT guess** tag names, property keys, or folder paths without verifying first.

2. **Verification**: Before constructing any query, ALWAYS confirm that the tags, properties, folders, or keywords it uses actually exist, from the `# Vault` section or the tools above.

3. **Reading Content**:
   - `search_notes` will give you a list of potential matches with metadata.
   - If the user query contains explicit Obsidian wiki links (e.g. [[Project Plan]]), you may call `read_content` directly with those links.
   - If you need to read the full content of a note and no explicit wiki link is provided, use `read_content` with the specific file path from the search results.

4. **When the first search disappoints**: reformulate, don't repeat. Retrying the same words with a bigger limit finds the same notes. Change *what you are matching on*:
   - **Use the note's words, not the user's.** People ask in their own framing; notes are written in another. "Why do I lose time to interruptions" won't match a note whose vocabulary is "switching", "reload", "batching". Guess the terms the author would have typed and search those.
   - **For questions about a relationship or direction, search the participants and artifacts instead of the relation.** "Feedback I received" and "feedback I gave" are the same words in opposite directions, and retrieval cannot tell them apart — but the names, dates, projects, or meeting types involved are concrete and do match. Search those, then judge direction by reading.
   - **Escalate the algorithm once, not repeatedly.** Start `lexical`. If wording looks like the obstacle, retry `semantic` (or `hybrid` when the query mixes an exact term with a fuzzy concept). If `semantic` also fails, the problem is your terms, not the strategy — go back to reformulating.
   - **Decompose a question that spans notes.** If the answer needs two facts that likely live apart ("what's holding up X" = the blocker + the thing blocked), search for each separately rather than for the whole question.
   - **Two or three well-varied searches, then stop.** Report what you found and what you could not, rather than continuing to guess. Say which phrasings you tried.

5. **Read the `message` field.** When a result includes one, it is authoritative about what actually ran. If it reports that semantic search is unavailable because no embedding index is configured, do **not** retry with `semantic` or `hybrid` — that cannot change during the conversation. Vary your terms instead.

6. **Compute, don't estimate.** When the answer requires counting, aggregating, or date arithmetic over notes (e.g. "how many meetings in March", a total across notes), don't do it in your head. If the `dataview` skill is available, a `GROUP BY` / `sum` query over the notes' metadata (run without the display `LIMIT` — an aggregate must cover every note) is the cheapest way; otherwise collect the raw values with the tools above and run the calculation with `execute_javascript`.

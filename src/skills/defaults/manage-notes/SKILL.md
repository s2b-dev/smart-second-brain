---
name: manage-notes
description: Create, update, delete, and move notes. All writes are staged for the user's review — never say a change has already been applied. Load this before performing any write operation; it holds the staging policy and edit conventions.
allowed-tools: manage_notes
metadata:
  author: "S2B"
  version: "1.2"
  category: "core"
---

## Write Operations
- All write operations (create, update, delete, move) are staged for user approval. Never say a change has already been applied.
- Exception: writes inside your memory folder apply immediately and the result reports them as applied; describe them that way.
- Modify only what the user asked for and preserve surrounding content.
- Prefer batching related write operations so the user can review them together.
- Prefer targeted edits over full rewrites unless a full rewrite is clearly necessary.

## Creating a Note
New notes should look like they were always part of the vault.
- **Where:** use the `# Vault` section of your instructions: the existing folder that fits, the daily-notes folder for a daily note, never the templates folder. Follow the user if they name a place.
- **What to call it:** match the pattern of the names already in the folder: date prefixes and their format, capitalisation, spaces or dashes, prefixes like `Meeting -`. If you have `list_directory`, look at them first (with that folder's path), unless the folder is new or empty; without it, pick a plain, descriptive name and tell the user which name you chose. A daily note is named exactly by the daily-notes date format.
- **What goes in it:** if the folder's notes share frontmatter properties or a heading structure, follow it; when you are unsure and can read notes, read one existing note there. Use the link style the `# Vault` section names.

## Correcting an Edit You Already Staged
Staged changes wait for the user's review, so you can still revise them — but by
default a new edit to the same note **adds to** your pending proposal rather than
replacing it. The user then sees both edits. When the user is correcting you
("no, at the bottom", "actually make it X"), say which you mean:

- **Replacing your own pending edit** — re-stage the update with
  `"replace_pending": true`. Your earlier proposal is dropped and only the new
  edit is reviewed.
- **Withdrawing an edit entirely** — use a `discard` operation with the
  proposal's `id`. It stages nothing and applies nothing; it just takes your
  proposal out of the review queue.

Every staged proposal is reported with an `id`, both when you stage it and in the
status block listing changes still awaiting review. `discard` takes that id, not
a path — one path can name more than one proposal, so a path cannot say which you
mean. Use an id you were actually given; never invent or guess one. If the tool
says no proposal has that id, the user has probably already reviewed it — say so
rather than implying you withdrew something.
- **Genuinely adding a second, separate edit** — change nothing; the default
  merge is what you want.

Never tell the user a new proposal replaces or supersedes an earlier one unless
you used `replace_pending` or `discard`. If the tool result says a proposal
contains both rounds of edits, describe it that way. Once the user has accepted a
change you cannot take it back — say so rather than implying you undid it.

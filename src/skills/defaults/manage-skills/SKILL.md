---
name: manage-skills
description: Create, revise, or delete skills with manage_skills — author new skills, fold verified knowledge into an existing skill's instructions, or remove a skill you created. Changes apply immediately. Load this before editing or creating a skill.
allowed-tools: manage_skills
metadata:
  author: "S2B"
  version: "1.2"
  category: "core"
---

## Managing Skills

Every operation below applies immediately — there is no staging or review step. Be deliberate;
by the time you get a result back, the change has already happened.

Skills are where task knowledge lives: how a kind of task is done here, the pitfalls, and the
user's corrections about that work. Memory holds facts about the user and pointers into the
vault; it is not the place for procedures.

**Revising a skill** — load it with `load_skill` first. Patches and updates are refused until you
have read the skill in this conversation, so the change is written against its current text.
- Revise the skill you used whenever it misled you or lacked a step, and whenever the user
  corrects how this kind of task should be done. Do it before you finish the task; those
  corrections live here, not in memory.
- Do this to make verified knowledge permanent: after you discover how a task actually works
  (e.g. a plugin's real API), fold the concrete methods, arguments, and patterns into the skill
  so future runs skip re-discovery.
- Fix in place: change the sentence that was wrong. Never append an "Update:" paragraph under it.
- Write lessons, not logs: one rule per point, imperative plus one clause of why. No narration of
  what happened, no dates.
- Only write instructions you have actually confirmed — never speculative or unverified steps.
  A skill full of guesses is worse than none.
- A skill's name and plugin link are locked; you can change the body and description only.

**Patch** — the normal way to revise: give the exact passage to replace, copied from the loaded
skill, and its replacement. The passage must match exactly once, so include enough surrounding
text to make it unique. An empty replacement deletes the passage. Frontmatter cannot be patched.

**Update** — replace the whole body (and optionally the description). Use it only when the skill
needs restructuring; for anything smaller, patch.

**Create** — author a brand-new skill: give it a name, a one-line description, and instructions
(body). You may request a small set of built-in tools for it via `allowedTools`; only tools from
an allowed subset are granted, others are silently dropped.
- Create when the workflow has no home in an attached skill; prefer extending a skill that
  already covers the area.
- A skill you create is attached and usable immediately — there is no separate enable step.
- Keep new skills narrow and instructions concrete — write down only what you'd actually want to
  remember doing again.

**Delete** — remove a skill you created, immediately and without confirmation. Built-in core
skills cannot be deleted.

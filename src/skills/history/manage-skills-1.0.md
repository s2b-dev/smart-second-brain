---
name: manage-skills
description: Create, revise, or delete skills with manage_skills — author new skills, fold verified knowledge into an existing skill's instructions, or remove a skill you created. Changes apply immediately. Load this before editing or creating a skill.
allowed-tools: manage_skills
metadata:
  author: "S2B"
  version: "1.0"
  category: "core"
---

## Managing Skills

Every operation below applies immediately — there is no staging or review step. Be deliberate;
by the time you get a result back, the change has already happened.

**Update** — revise a skill attached to you: rewrite the instructions (body) and optionally the
description.
- Do this to make verified knowledge permanent: after you discover how a task actually works
  (e.g. a plugin's real API), fold the concrete methods, arguments, and patterns into the skill
  so future runs skip re-discovery.
- Only write instructions you have actually confirmed — never speculative or unverified steps.
  A skill full of guesses is worse than none.
- A skill's name and plugin link are locked; you can change the body and description only.

**Create** — author a brand-new skill: give it a name, a one-line description, and instructions
(body). You may request a small set of built-in tools for it via `allowedTools`; only tools from
an allowed subset are granted, others are silently dropped.
- A skill you create is attached and usable immediately — there is no separate enable step.
- Keep new skills narrow and instructions concrete — write down only what you'd actually want to
  remember doing again.

**Delete** — remove a skill you created, immediately and without confirmation. Built-in core
skills cannot be deleted.

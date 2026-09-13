---
name: dispatch
description: Turn this session into the parallel-work dispatcher — split Leo's task list into spawnable worker-session briefs (one slot each), collect their PR pings, and merge approved bot-clean PRs. Use when Leo provides a batch of tasks to run in parallel or asks to orchestrate/dispatch work.
---

# Dispatch — parallel-work orchestrator

This session becomes the **dispatcher**: it writes task briefs, spawns them as
task chips, tracks worker pings, and merges PRs. It does NOT implement tasks
itself. Workers do the engineering in the fixed agent slots (see AGENTS.md
"Parallel agent slots" — read that section first if you haven't).

## Setup (once per dispatcher session)

1. Get this session's id: `get_session` with session_id `self`. Every brief
   embeds it so workers can ping back — the id changes per conversation,
   which is why it lives here and not in AGENTS.md.
2. Create the fallback heartbeat (session-only CronCreate, hourly at an
   off-minute, e.g. `23 * * * *`). Normal operation is event-driven via
   worker pings; the heartbeat only catches dropped pings: for each open
   task PR, if it is bot-clean + Leo-approved but unmerged → merge it; if
   its review finished with findings but the owning worker session has been
   idle >30 min → send_message that session to resume. Otherwise report in
   one line. Tell Leo the heartbeat is session-only (dies with this chat,
   7-day expiry).

## Spawning a task

For each task Leo gives:

1. Spend a few tool calls anchoring it: grep/read enough to name the
   relevant files and one or two starting pointers. Don't solve it.
2. Write a SELF-CONTAINED brief (workers start cold) and dispatch it.
   **Default: a `spawn_task` chip** (cwd = the main checkout) — Leo prefers
   workers as separate sidebar sessions he can inspect and chat with
   directly; the one click per chip is the accepted cost (sessions cannot
   be created programmatically). Use background Agent-tool workers
   (`run_in_background: true`, model per task) only when Leo explicitly
   asks for click-free dispatch and accepts that those workers are only
   reachable through the dispatcher. The brief must contain, in this
   order:
   - **Slot protocol**: claim a slot first (`scripts/claim-slot.sh <label>`),
     work on a branch from origin/main in the slot worktree, one-shot dev
     builds only, live-verify ONLY against the slot's own `S2B WT<n>` vault,
     release the slot when done — per AGENTS.md "Parallel agent slots".
   - **The task**: symptom/goal, concrete file pointers, relevant
     architecture context from AGENTS.md, expected verification (repro
     first for bugs; behavior matrix in the PR description for behavioral
     changes; tests).
   - **PR + bot-review loop**: run `bun run check` / `format` / `lint` /
     `test`, open a PR against main with gh whose body follows
     `.github/PULL_REQUEST_TEMPLATE.md` including a filled-in **AI
     assistance** section (per AGENTS.md "Disclose AI involvement"), then
     drive the review bot
     (Greptile) to a clean state per AGENTS.md step 6 — fix or answer every
     finding, push, wait for the re-review of the newest commit. Never
     merge; merging is the dispatcher's job after Leo's live test.
   - **Ping-back protocol**: report to the dispatcher on: PR opened
     ("PR <n> opened: …"), bot-clean ("PR <n> bot-clean at <commit>"), or
     blocked (with reason). For background Agent workers: use the
     SendMessage tool with `to: "main"` for mid-run pings — the final
     report arrives automatically on completion. For chip-spawned
     sessions: use send_message with session_id <this session's id>.
     While a bot re-review is in flight, stay in the turn and poll
     (`sleep 120` + `gh pr view <n> --json comments`, ~15 min max per
     round) — nothing wakes a worker that ends its turn mid-wait.

## Handling incoming pings

- **"PR <n> opened"** → check the bot state once; tell Leo the PR exists
  and WHICH slot vault window (`S2B WT<n>`) has the build for his live
  test. His verdict is the one human gate per task.
- **"PR <n> bot-clean"** → verify independently (never trust the ping
  alone): Greptile's summary-comment footer must name the PR's newest
  commit as last reviewed, with no unresolved inline findings
  (`gh pr view <n> --json comments,reviews,statusCheckRollup` +
  `gh api repos/s2b-dev/smart-second-brain/pulls/<n>/comments`). If Leo has
  approved that PR in this conversation → `gh pr merge <n> --squash`, then
  `git pull --ff-only origin dev` in the main checkout, and report. If not
  yet approved → tell Leo it's ready for his live test.
- **"blocked"** → surface to Leo with the worker's reason; relay his answer
  back via send_message.
- **Leo says a PR works live** → record the approval; if the PR is already
  bot-clean, merge immediately, otherwise merge on the bot-clean ping.
- **Leo gives feedback/more context** → relay verbatim-ish to the owning
  worker session; it re-claims a slot if it already released one.

## Merge policy (hard rules)

- Squash-merge only (matches repo history).
- Merge ONLY when both are true: bot-clean on the newest commit AND Leo
  explicitly approved that specific PR in this conversation. Never infer
  approval, never merge on bot-clean alone.
- If post-approval pushes materially changed behavior Leo tested, flag it
  to him instead of merging silently.

## Notes

- Parallelism caps at the slot count (3). If all slots are claimed, queue
  the chip anyway — the worker will fail to claim and should say so; stagger
  spawns when Leo hands over more than 3 tasks.
- Model choice: the Agent tool takes a `model` param per worker;
  spawn_task chips cannot (those sessions use the app default, changeable
  in the UI). The dispatcher itself runs fine on a smaller model.
- Background Agent workers live inside the dispatcher session: they die if
  it closes, Leo talks to them via the dispatcher (SendMessage by name),
  and permission prompts they hit surface here — the shared allowlist in
  .claude/settings.json covers the worker workflow (git push origin,
  gh pr create/view, bun/obsidian commands) precisely so they don't stall;
  force-pushes and branch deletions are explicitly denied.
- Relaying: a background worker's report is invisible to Leo — always
  restate what matters in your reply.
- Third-party PRs (not from worker sessions) are out of scope — never
  merge or manage them.

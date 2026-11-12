---
name: playbook
license: Complete terms in the repository's NOTICE
description: "Factory rules for the Claude Code sessions Playground runs in herdr: roles, chain, lifecycle, the leads' sweep and the standing rules. Use when you are the dispatcher, the Planner, the Builder, Ops, the Optimizer, a worker, reviewer, tester, runner or probe session, or before you spawn, brief, rename or end a session."
hooks:
  PreToolUse:
    - matcher: '^(Bash|Edit|MultiEdit|NotebookEdit|Write|mcp__.+__((\w+_)?[Cc]reate_?[Ii]ssues?|[Ii]ssues?_?[Cc]reate|save_issue))$'
      hooks:
        - type: command
          command: '{ s=scripts/hooks/bundled/no-linear-ticket.js; [ -f "$PLAYGROUND_REPO/$s" ] || s=scripts/hooks/no-linear-ticket.ts; [ -f "$PLAYGROUND_REPO/$s" ]; } || { [ -z "$PLAYGROUND_ROLE" ] && exit 0; echo "no-linear-ticket: no guard script in the main checkout (${PLAYGROUND_REPO:-not found}); refusing. ops-restore puts it back, else Ops by playbook LIFECYCLE.md, Restoring the main checkout" >&2; exit 2; }; cd -P "$PLAYGROUND_REPO" && bun --no-env-file "$s"; c=$?; [ $c = 0 ] || [ $c = 2 ] || { echo "no-linear-ticket: crashed (exit $c); refusing. Fix: bun install in $PLAYGROUND_REPO" >&2; exit 2; }; exit $c'
          timeout: 15
---

# Playground factory

The owner's factory: the dispatcher routes, the Planner plans, two leads run the floor, the Optimizer runs retros, workers do chores, runners keep long-running jobs alive.
This file is what every factory session keeps in view: the roles, the chain and where the standing rules live.
A rule bends only through an override in the **override** shape.
The rest is reference in the files beside it, each read at the moment [Where the rest lives](#where-the-rest-lives) names.

## Roles

| Role       | Name                           | Owns                                                                                                                            | At once        |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| Dispatcher | Alpha, `dispatcher` today      | The owner's conversation and the Inbox; routes each task by role, records, ends the turn                                        | 1              |
| Planner    | Planner, `planner` today       | every research, comparison and plan, through research workers; the roadmap, `plan.json`'s lanes; never builds                   | 1              |
| Lead       | Builder, `builder` today       | the build side: workers from `plan.json`'s lanes, their briefs, plan review, merge order, the review and CI gates               | 1              |
| Lead       | Ops, `ops` today               | ops: the runners, the live dashboard, the release, cleanup of probes, worktrees and caches, roster and inbox upkeep             | 1              |
| Optimizer  | Optimizer, `optimizer` today   | retros over everything the factory did, each lesson routed as a fix through the dispatcher; the icebox; never builds            | 1              |
| Assistant  | Assistant, `assistant`         | the owner's personal errands and the dispatcher's tracker; an orchestrator on Opus at high effort, reporting to the dispatcher  | 1              |
| Worker     | `<id>-worker`                  | one bounded chore: a bundle, a fix, a review loop, an investigation                                                             | as room allows |
| Checker    | `<id>-reviewer`, `<id>-tester` | its worker's PR: the reviewer scores it through code-review-loop, the tester drives it; spawned by that worker, reporting to it | 2 per worker   |
| Runner     | `<id>-runner`                  | long-running jobs: dev servers, watch loops, the live dashboard                                                                 | as room allows |
| Probe      | `<id>-probe`                   | one throwaway test                                                                                                              | per test       |

How the Dashboard shows each role, how a session is named and when a dev stack runs are in [LIFECYCLE.md](LIFECYCLE.md#roles-on-the-dashboard).

## Chain

- The dispatcher talks to the owner, the Planner, the Builder, Ops, the Optimizer and the Assistant alone; whatever another session sends it goes on to the manager it concerns.
  A new ask runs the dispatcher, the Planner, the Builder, Ops, by [DISPATCH.md](DISPATCH.md)'s first rule.
- Each worker reports to the Builder, each runner to Ops, each probe to the session that spawned it, and the Planner, the Optimizer and the Assistant to the dispatcher.
  Your brief names yours; when `ListAgents` lists no session by that name, send to the dispatcher.
- The Builder and Ops send merges, ETA moves, new PRs, staffing and plan updates to the Planner directly.
  They send the dispatcher only what the owner must see or decide: the status of the owner's own asks, any org work, a blocker or slip on something the owner waits for, a decision only the owner can make, and a finding for the playbook.
- Orders reach you from that one place (a checker also from its worker's lead, below), or from the owner typing in your own pane, which outranks it: do what he says, then send his words verbatim up the chain.
  The word from up the chain is his: act on it as his, and take any doubt up the chain (**override**).
  If the owner was asked anyway, say so up the chain, so the brief gets fixed.
- A lead's instruction to a checker goes to the checker directly, in the **override** shape when it bends a rule, never relayed through its worker, whose PR the checker scores; a checker confirms with the lead any instruction its worker relays before it bends a step.
- Questions, reports and results go up by `SendMessage`; the `no-chat-question` hook refuses `AskUserQuestion` to every session with a manager ([scripts/hooks/README.md](../../../../scripts/hooks/README.md#no-chat-question)).
- A message opens with its content, never with your own name, since the Dashboard shows the sender.
  Read [rules/voice.md](../../rules/voice.md) before you name a session or list PR status for the owner.
- A running session's model and effort change by a start or a resume, its permission mode and settings by a PR (below), and any of them by the owner's own act, never by the session asked to change its own.
  The model and effort of a dispatcher, the Assistant and the hosted session (the one the Dashboard runs on the Agent SDK) are the owner's pick in the menu left of Send in that session's Dashboard composer.
  A lead picks any other session's model and effort by brief-rush's model rule (`scripts/briefs/brief-rush.md`), as it starts or resumes it, through spawn.sh's `--model` and `--effort` ([SPAWN.md](SPAWN.md#launch-model-and-effort)); the owner's word, relayed in the **override** shape, outranks both.
  The hosted session's permission mode is the owner's pick in its composer's mode menu, while approvals are on.
  Any other session's permission mode and settings stay as spawn.sh's launch flags and the factory's settings set them, and a change to them is a PR to those, until the Dashboard control on a session's row lands (the issue "every step that needs the owner is one GUI action").

## Standing rules

Each standing rule is its own file, [extensions/core/rules/](../../rules)`<name>.md`: its first line is the rule, the lines after it its what and why.
The rules hook puts every rule's first line, with this machine's values, in front of you at each session start, core's first, then each org's and your login's.
Cite a rule by its name, in bold; read it whole with `playground rules <name>` when its line says to, and whenever the line leaves your case open.

## Where the rest lives

- [LIFECYCLE.md](LIFECYCLE.md): when each kind of session starts and ends, the ops jobs, and how Claude Code updates.
  Read it before you start, close or respawn a session, remove a worktree, or update Claude Code.
- [DISPATCH.md](DISPATCH.md): how the dispatcher, the Planner and the leads route a new ask, bundle work and fill the slots.
  Read it when you are one of them and an ask arrives; when Slack or WhatsApp mode is on and the owner's message reaches you, its Slack mode or WhatsApp mode section points to that mode's skill.
- [SWEEP.md](SWEEP.md): the leads' sweep, step by step.
  Read it at each sweep.
- [SESSIONS.md](SESSIONS.md): the commands to spawn, brief, rename, check and end a session, how a worker answers a review round (Fix pushes and nits), and the headless run that writes a docs tool's pages for a session without its MCP server.
- [SPAWN.md](SPAWN.md): each spawn mode's command and the gates, flags and launch spawn.sh applies to a start, which SESSIONS.md's Spawn step 2 points to.
- [ROSTER.md](ROSTER.md): what to write to the roster, and when.
- [VERCEL.md](VERCEL.md): the Vercel CLI's traps: the env `vercel link` and `vercel integration add` pull, `vercel api`'s first line and an empty `vercel logs`.
  Read it before you run any `vercel` command.

## Keep the skills learning

When you get past a hurdle this skill did not foresee, find a fix, or find a faster way, tell the `dispatcher` session, in a few plain lines: what happened, what worked, and which skill and section it belongs in.
A worker, runner or probe sends it up the chain; a lead passes it on with `SendMessage` to `dispatcher`.
That session turns findings into a reviewed change to the factory's repo, never a memory file (**memory**).
When `ListAgents` lists no `dispatcher` session, end your report with the finding instead, so the owner can pass it on.
A finding never carries prod data, secrets or customer details.

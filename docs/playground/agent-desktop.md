## What it does

`agent-desktop` lets a session operate a desktop app, such as Finder, through the [agent-desktop](https://github.com/vercel-labs/agent-desktop) CLI, which reads and drives apps through the macOS accessibility tree.
The binary carries its own docs, matched to its version, so the skill sends the session to them and adds only what the binary cannot know: whether this Mac lets the session run it, and what stays yours.
Your desktop is your own screen, so the skill keeps every session headless, away from your own apps, and keeps what it saw on the screen out of anything it writes outside its session.

## When to reach for it

A session loads it on its own before any `agent-desktop` command, or when a task needs a desktop app driven.

| Case                                                 | What the skill does                                                                                                                     |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| The binary is missing, or a macOS grant is not given | Stops, and tells its manager the one action: Ops installs it, or you approve an Inbox card that opens System Settings at the permission |
| Both are in place                                    | Loads the binary's own docs (`skills get desktop`, `skills get platform`), then works headless                                          |
| The task would touch one of your own apps            | Leaves the app alone                                                                                                                    |
| The task needs `--headed`                            | Hands it to you as one command to run with `!`                                                                                          |
| The task needs a window the app does not show        | Runs only while your screen is unlocked, with your yes to taking focus, in a stretch you are idle, and stops once you come back         |

## The grants

macOS asks you, not the session, for two permissions: Accessibility, which every task needs, and Screen Recording, which only a screenshot needs.
macOS gives them to the app that launches `agent-desktop`.
A factory session runs under the herdr server, not a terminal you opened, so herdr is most likely the app to grant; the first trial after your grant confirms it.
The session reads the grants with `agent-desktop permissions`, which never prompts.
For a grant that is missing, its manager posts an Inbox card: its Approve opens System Settings at Privacy & Security, Accessibility or Screen Recording, you turn it on there, and the manager checks the grant again and tells the session that stopped, which goes on once it reads granted.

## It's working if

- A session on a Mac with no grant stops at its first step and names the permission to grant, rather than trying a command.
- Your pointer and focus stay where you left them while a session works.
- The apps on your list stay as you left them: a session opens, reads and closes none of them.
- PRs, comments and reports describe what a session saw in words, with no snapshot or screenshot attached.

## Where it fits

A core skill beside [agent-browser](../../skills/zerostarter/agent-browser/SKILL.md), its browser sibling from the same upstream.
The `no-desktop-owner-app` hook refuses the skill's two rules in every session, `--headed` and any command naming an app on your list, and its refusal names the two routes past it: you run the command with `!`, or you take the app off your list by approving an Inbox card a session's manager posts.
A session trying it before it merges follows [.agents/skill-trial.md](../../.agents/skill-trial.md).

---
name: setup
description: "Check and set up what the skills need on this machine: the command-line tools and the gh login, the home skill set, and each extension's own needs through its setup check. Run once on a new machine, or when a skill fails for a missing tool or connection."
license: Complete terms in the repository's NOTICE
disable-model-invocation: true
allowed-tools: "Bash(${CLAUDE_SKILL_DIR}/scripts/check.sh)"
---

# setup

Get this machine ready for Playground's skills and each extension's: check, show the user what is missing, fix what they agree to, check again.

## 1. Check

Run `${CLAUDE_SKILL_DIR}/scripts/check.sh`. It prints one line per command-line need: `ok`, `MISSING` with its fix, or `optional`. Its last lines are each extension's own, from its `scripts/setup/check.sh` (`<data>/extensions/<scope>/scripts/setup/check.sh`).

Then check the connections only Claude Code can see. An extension's check prints each connection its skills need as a line `mcp <label> <tool>, <tool>...`, which leaves its exit code alone: load each named tool with ToolSearch, since a tool that does not load means its server is not connected, and report a missing one beside the script's failures.

**Done when** every line of the script and every `mcp` line's tool has a result.

## 2. Show

One table, required needs first: the need, ✅ or ❌, and the fix. Lead with how many are missing.

**Done when** the user has seen the table and been asked whether to fix what is missing.

## 3. Fix

Ask before changing anything. With the user's go-ahead, run `${CLAUDE_SKILL_DIR}/scripts/check.sh --fix` with a 10-minute timeout: it installs missing required tools with Homebrew and the home skill set, through the checkout's `scripts/link-skills.sh`. What needs the person, give as the exact thing to type:

- the GitHub login: `! gh auth login`;
- a server that is configured but not connected: `/mcp`, then authenticate it;
- a server that is not configured: it comes from the workspace setup that owns the shared MCP config, so name the server and ask them where it lives rather than guessing a URL.

**Done when** the fix ran, or the user declined it.

## 4. Check again

Run the script and the reads again.

**Done when** every required need is ✅, or the user has the exact command for each one still ❌.

## Keep the skills learning

When you get past a hurdle this skill did not foresee, find a fix, or find a faster way, tell the `dispatcher` session: `SendMessage` to `dispatcher` with what happened, what worked, and which skill and section it belongs in, in a few plain lines. That session turns findings into a reviewed change to the factory's repo. When `ListAgents` lists no `dispatcher` session, end your report with the finding instead, so the owner can pass it on. A finding never carries prod data, secrets or customer details.

## What it does

`setup` gets a machine ready for Playground's skills, such as [code-review-loop](./code-review-loop.md), and for each extension's: an extension's own `scripts/setup/check.sh` runs at the end of the same check.
It checks every tool and connection they need, shows one table of what is missing with the fix for each, and with your go-ahead installs what it can.

| Need                                                                                                                     | Used by                                                                               |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `git`, `gh` and its login, and gh as git's credential helper                                                             | every skill: PR and branch checks, PRs, fetches that never stall on a keychain prompt |
| `python3`                                                                                                                | the ops scripts                                                                       |
| `npx`                                                                                                                    | the MCP servers that run through npx                                                  |
| `uv`, `pnpm`                                                                                                             | this repo's Python tests, and a pnpm repo's gates                                     |
| Claude Code 2.1.224 or later                                                                                             | the forked skills, and messages between sessions                                      |
| the home skill set, `ws-home@ws`, at user scope                                                                          | everything                                                                            |
| bypass mode as the default in `settings.json` (`~/.claude`, or `$CLAUDE_CONFIG_DIR`), with its prompt skipped (optional) | the factory's sessions, so messages between them are never held for approval          |
| each extension's `scripts/setup/check.sh`, and the tools its `mcp <label> <tool>, ...` lines name                        | that extension's skills                                                               |

Your Claude and GLM accounts are not part of the check: add each one with Add account on the Settings page or `playground accounts add` ([Settings](../../web/next/content/docs/settings.mdx#add-an-account)).

## When to reach for it

Type `/setup` once on a new machine, and again whenever a skill stops for a missing tool or connection.
The command-line half also runs alone: `extensions/core/skills/setup/scripts/check.sh`, with `--fix` to install.

## It's working if

- The table lists every need with ✅ or ❌, and each ❌ comes with the exact fix.
- Nothing is installed before you say yes.
- What needs you (the GitHub login, connecting an MCP server) arrives as a command to type.

## Where it fits

The setup step before the other skills: explore, show, confirm, fix.

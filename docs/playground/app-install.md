## What it does

`app-install` carries a routine for a session that installs, moves, or updates an app on a factory machine, so the app starts the way the owner starts it, and tells the session to call an app ready only with launch proof.
On Ubuntu, `kernel.apparmor_restrict_unprivileged_userns` lets an app make an unprivileged user namespace only at a path an AppArmor profile grants `userns` to, so a Chromium- or Electron-based app quits at its first real start when no profile covers its installed path, printing "No usable sandbox!".
The skill carries the repo's own `bwrap-userns` lesson for Claude Code's sandbox into a general install, and adds the menu entry and the launch proof an owner's start needs.

## When to reach for it

A session loads it on its own before it installs, moves, or updates an app, a browser, or any build the owner opens, and before it reports one ready, installed, or live.

| Case                                                   | What the skill does                                                                                                                                           |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An app with a sandbox has no profile covering its path | Adds or extends an AppArmor profile granting `userns,` to the path, loading it, and sends the `/etc` write to the owner as one Inbox root step                |
| The app is at its installed path                       | Launches it with its sandbox on and its real settings, in a profile folder of its own, keeping the exit status or a screenshot, and never with `--no-sandbox` |
| The install writes a `.desktop` entry                  | Keeps its 644 mode, runs `update-desktop-database`, and gives an app the owner expects to see a spot on page 1 of Show Apps through `app-picker-layout`       |
| The skill has finished                                 | Reports the app ready or installed only with the launch and its evidence, otherwise built or staged                                                           |

## The launch proof

A version print, a `--help`, or a run from the build folder proves the build, not the install, since a build can print its version and still fail at its first real start.
Ready is claimed only after the app launches at its installed path, as the owner's user, with its sandbox on and its real settings, in a profile folder of its own.

## It's working if

- A session on Ubuntu reads the setting and lists `/etc/apparmor.d/` before it installs, rather than printing a version.
- The app opens at its installed path with no "No usable sandbox!"
  message, and stderr holds no sandbox or permission error.
- The entry is 644 and the app shows in Show Apps where the owner expects it.
- A report says built or staged until the launch is proven, then ready with the launch and its evidence cited.

## Where it fits

A core skill beside [agent-desktop](../../extensions/core/skills/agent-desktop/SKILL.md) for apps the accessibility tree drives, and beside the `bwrap-userns` root step that already applies the lesson to Claude Code's own sandbox.

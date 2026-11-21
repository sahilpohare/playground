---
name: app-install
description: Install, move or update an app on a factory machine so it starts the way the owner starts it, and call it ready only with proof. Use before you install, move or update an app, a browser or any build the owner opens, and before you report one ready, installed or live.
---

# App install

An app is ready when it has launched at its installed path, as the owner's user, with the settings it runs with there.
A version print, a `--help` or a run from the build folder proves the build, not the install: a build can print its version and still fail at its first real start.

## Steps

1. **AppArmor first.** On an Ubuntu machine, read `sysctl kernel.apparmor_restrict_unprivileged_userns` and list `/etc/apparmor.d/`.
   While the setting is 1, an app with a sandbox (Chromium or Electron based, or any app that makes an unprivileged user namespace) starts only at a path an AppArmor profile grants `userns` to; anywhere else it stops with "No usable sandbox!".
   Done when you know the setting's value and which profile, if any, attaches to the app's installed path.
2. **Profile in the install.** When no profile covers the installed path, add one, or extend the profile that covered the old path, granting `userns` to the new path, and load it with `apparmor_parser -r`.
   A file under `/etc` needs root, so it reaches the owner as one Inbox root step, the way the `bwrap-userns` step does for Claude Code's sandbox (`api/hono/src/lib/system/root/bwrap-userns`).
   A script that installs to a path keeps that path and the profile's attach path in one variable, or checks that they match before it switches.
   Done when a loaded profile's attach path covers the installed path.
3. **Launch proof.** Start the app from its installed path, as the owner's user, with its sandbox on and its real settings (permissions, config), in a profile folder of its own so the owner's open session stays untouched.
   Keep the exit status and stderr, or for an app with a window, a screenshot of it.
   Done when it exited 0 or its window shows, and stderr holds no sandbox or permission error.
   A run with `--no-sandbox` skips the very check that fails at the owner's start, so it proves nothing here.
4. **Menu entry.** A `.desktop` file the install writes or rewrites under `~/.local/share/applications` keeps the mode its siblings have (644), and the install then runs `update-desktop-database ~/.local/share/applications` and touches that folder, so GNOME keeps it in Show Apps.
   GNOME adds a new app at the end of the app grid, often on page 2, since `org.gnome.shell app-picker-layout` lists only the system's defaults; an app the owner expects to see gets a spot on page 1 through `gsettings set org.gnome.shell app-picker-layout`, after the old value is saved with `gsettings get`.
   When an app is reported missing from Show Apps, check the entry's mode and the app grid's layout first.
   Done when the entry is 644 and the app shows in Show Apps where the owner expects it.
5. **Report.** Say ready, installed or live only with steps 3 and 4's evidence cited; before that, say built or staged.
   Done when the report names the launch and its evidence.

Sources: https://discourse.ubuntu.com/t/ubuntu-24-04-lts-noble-numbat-release-notes/39890, https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007

## Keep the skills learning

When a factory machine takes the AppArmor `userns` grant differently than this skill expects, or the menu entry lands somewhere the owner did not find, tell the `dispatcher` session: `SendMessage` to `dispatcher` with what the machine showed, what worked, and which step it belongs in, in a few plain lines. That session turns findings into a reviewed change to the factory's repo. When `ListAgents` lists no `dispatcher` session, end your report with the finding instead, so the owner can pass it on. A finding never carries prod data, secrets or customer details.

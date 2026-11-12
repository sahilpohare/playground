# Ops alerts go through a relay, not a pane

Ops jobs (notify.sh, ops-dm-watch) typed their alerts into session panes with `cmux send`. Text typed into a pane lands as a user turn, so the session read each alert as the owner's own words, and nothing may go out on the owner's behalf. Ops moved every job to a queue on 7 Oct 2026: `notify.sh` writes each line to `~/.playground/ops/outbox/`, and Ops' 5-minute sweep relays it with `SendMessage`, so it arrives as a cross-session message from Ops, at the cost of up to 5 minutes of lag.

An issue asked whether a script could skip the relay and send over a session's inbox socket (`/tmp/cc-socks/<pid>.sock`) as a named sender, such as `ops-checks`.

## Decision

The relay stays. Claude Code documents the inbox socket ([cross-session messaging](https://code.claude.com/docs/en/cross-session-messaging#the-sessions-inbox-socket)) for a script posting to its own session, which the session verifies as its own child. An ops job is no session's child, so the receiving session treats its message as one that asserts no permission class, and a session that bypasses permission prompts (every factory session) holds it for the owner's approval in its pane, dropping it after five minutes. That puts the owner back in the loop and loses the alert. A message delivers only when it claims a permission mode in the socket's undocumented wire format, which spoofs the check that holds it, when it presents the session's own `CLAUDE_CODE_MESSAGING_TOKEN`, which only that session's children hold, or when the receiving session's settings say `crossSessionInbound: accept`.

`crossSessionInbound: accept` in `scripts/factory-settings.json` is the one alternative: every factory session would then take any local sender's message, a prompting session's included. It is a permission boundary, so only the owner opens it; this decision changes nothing there. Channels, which push events into a session from an MCP server, are a research preview that needs a channel server loaded into every session, too much for an alert line.

The dashboard's `deliver()` types only for the owner's own clicks: the composer, a board's row actions and the owner's answer to an inbox item. Tests fail when any other file calls it (`tests/api/hono/src/lib/dashboard/deliver.test.ts`) or any text in the repo types into a pane (`tests/api/hono/src/lib/dashboard/herdr.test.ts`), Escape on a permission prompt aside, since it types no text. Since then, a manager's `playground picker` also presses Yes or Escape on its own session's permission prompt, tied to the call its alert named.

## Consequences

- An ops alert reaches its session from Ops, never as a user turn, up to 5 minutes late.
- A session takes its name at spawn: a `/rename` typed into its pane would read as the owner, and one sent by `SendMessage` is plain text Claude Code never runs.
- A picker the Feed can no longer answer, after its 120 seconds, waits for the owner in its own pane, where the dashboard shows it as Waiting on you: nothing is filed and nothing is typed.
- The ops scripts live outside the repo (`~/.playground/ops`), so the tests cannot read them; Ops keeps them to `notify.sh`.

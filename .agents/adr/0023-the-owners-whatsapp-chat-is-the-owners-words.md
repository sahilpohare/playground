# The owner's WhatsApp chat is the owner's words

The owner asked to talk to the factory over WhatsApp, through an unofficial client linked as a device on a spare number, and approved that one-way door through the Inbox (door 1), with factory status alone allowed over the chat (door 2).
A message the factory acts on as the owner's needs a sender it can trust; on the Dashboard that is the owner's own click (`deliver()`'s rule in `.agents/dashboard/messages.md`), and on WhatsApp no click exists.

## Decision

- **The allowlist stands in for the click.** ops-wa (`packages/scripts/src/ops-wa/`) hands on a message only when WhatsApp names its sender as `wa.owner` in a 1:1 chat, by its phone number or the number Baileys gives beside a LID. Every other message, a group's, a status's, a broadcast's, a newsletter's, a stranger's and every call, is dropped, with one line of time, kind and the sender's last 4 digits in `<data>/whatsapp/dropped.log`.
- **It reaches the dispatcher as a relayed owner message.** Inbound goes through the ops relay (`sendAs` in `packages/scripts/src/ops-job/job.ts`), the path Slack mode uses, so the dispatcher reads it as the owner's words relayed, never typed into a pane; `deliver()` and its rule stay as they are. The relay logs only the line's length (`NOTIFY_PRIVATE`), so the owner's words stay out of `alerts.log`.
- **One way out, to the owner alone.** `playground wa send <file>` reaches ops-wa through a unix socket in `<data>/whatsapp/` (mode 600), and ops-wa sends only to `wa.owner`, only within 24 hours of the owner's last message, so the spare number never starts a chat and never writes to itself or anyone else.
- **What travels is factory status.** `refusalOf()` in `bridge.ts` refuses a body holding a token shape (`secretIn`, the settings store's own list), checked in `wa send` before the socket and again in ops-wa; a later filter, such as phase 4's redactor, sits in front of it there.
- **The device stays the factory's.** The auth state, the socket and the state files live in `<data>/whatsapp/` (folder 700, files 600) under one process's lock, and the `no-raw-wa` guard refuses a session's call that reaches that folder; ops-wa pairs a device only once that guard is registered in `scripts/factory-settings.json` (`unguarded()` in `life.ts`), so no auth state exists without it.
- **The number is kept by habit.** Every ban-safety habit the plan names (`packages/scripts/src/ops-wa/habits.ts`) holds from the first connect: a backoff from 2 s to 30 s that stops after 12 failed tries, at most 20 connects an hour counted across restarts, a stop on a logout that waits for `playground wa relink`, no presence, read receipts or history sync, sends a second apart and at most 60 an hour, and a reminder 12 days after the link.

## Consequences

- Anyone holding the owner's phone holds the factory's ear, as anyone at the owner's unlocked Mac does; WhatsApp's own sender identity is the trust.
- WhatsApp's terms forbid unofficial clients and a ban takes the spare number for good; the habits lower that risk, and the spare number keeps the owner's own account out of reach.
- Answering Inbox items from WhatsApp (phase 4) acts for the owner with no click, so it extends this ADR in a version beside this one, carrying door 2's allowlist: open factory `ask` decisions and updates alone, a redactor before every send, no attachments, and a reply that quotes the card's id.

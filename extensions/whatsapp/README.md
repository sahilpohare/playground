# WhatsApp

A bundled extension: it ships in this checkout beside core, and only an owner who turns it on loads it.
It holds what Playground does on WhatsApp, your chat with the factory through a spare number linked to this Mac as a device: you text, the dispatcher answers.
Its skills go in `skills/<name>/SKILL.md` here: `whatsapp` holds WhatsApp mode, which tells a session how to answer through `playground wa send`.
The link itself is ops-wa, an ops job in `packages/scripts/src/ops-wa/` ([ADR 0023](../../.agents/adr/0023-the-owners-whatsapp-chat-is-the-owners-words.md)).

## Turning it on

Open Settings, then Extensions, and turn on **WhatsApp** under **Bundled with Playground**.
The switch adds `whatsapp` to `ext.bundled` at your login's scope (`playground settings set ext.bundled '["slack","whatsapp"]' --reason "<why>"` does the same from a terminal, keeping Slack on beside it), and that is WhatsApp mode: ops-wa hands your messages to the dispatcher only while it is on, and answers once an hour that it is off otherwise.
Sessions started after that read its skills after your own extensions and before core.

ops-wa also needs its two numbers and its job turned on: type them into the WhatsApp card's **Device number** (`wa.device`, the spare number) and **Your number** (`wa.owner`, the one it answers), each `+` and 8 to 15 digits, and Save.
A saved number shows by its last 4 digits alone, and an empty field keeps it; the spare phone then links by the pairing card the Inbox shows.

## Photos and voice notes

A photo or voice note you send is kept on this Mac in `<data>/wa/media/`, mode 600, and its path goes to the dispatcher with the photo's caption or the note's words; it stays out of the attachments folder.
Voice notes are read as text on this Mac by whisper.cpp: `brew install whisper-cpp ffmpeg`, then put a ggml model at `<data>/wa/whisper-model.bin` (`playground doctor` lists `whisper-cli` as optional).
Without them a voice note reaches the dispatcher as not transcribed, with its path.

## Inbox cards on WhatsApp

While WhatsApp mode is on and you have written in the last 24 hours, ops-wa sends you each open `ask` decision and update its poster scoped to the factory (`scope: "factory"`) from the Inbox once, with its choices numbered: reply `1 #i12` to pick choice 1 on #i12, and ops-wa answers it as the card's own button would, recorded as from WhatsApp ([ADR 0024](../../.agents/adr/0024-the-owners-whatsapp-answers-an-inbox-card.md)).
Every other card stays in the Inbox, counted in one line, `N cards wait in the Inbox`: a card with no scope, an org's work, a secret, a delete, a budget, a ship, a schema, a ticket, a Slack message and a draft.
A card that goes reads `[hidden]` for every name, handle, company term, Slack id, Linear key, email and token, and its files stay in the Inbox.

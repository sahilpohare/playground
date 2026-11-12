---
name: whatsapp
description: "WhatsApp mode: answer the owner's WhatsApp with `playground wa send`, in factory status alone. Use when ops-wa hands you an owner message, or at its 15-minute line asking for an update."
license: Complete terms in the repository's NOTICE
---

# WhatsApp mode

While this extension is on, the owner's WhatsApp is a chat with the factory: ops-wa, linked as a device on a spare number, hands each 1:1 message from the owner's number (`wa.owner`) to the dispatcher in full ([ADR 0023](../../../../.agents/adr/0023-the-owners-whatsapp-chat-is-the-owners-words.md)).
A message with no reply in 3 minutes while the dispatcher is not mid-turn, or any message while the dispatcher has read stuck or failed, also goes to the session in the assistant seat (`roster.ts who assistant`); with no session there, it stays with the dispatcher alone and ops-wa's log says so.
While the extension is off, ops-wa hands nothing on and answers the owner, at most once an hour, that WhatsApp mode is off.
The owner sets both numbers in Settings, Extensions, on the WhatsApp card (**Device number** for `wa.device`, **Your number** for `wa.owner`), which shows a saved one by its last 4 digits alone; when one is unset, point the owner to that card.

What goes over WhatsApp is factory status alone: the state of the factory's own work, never org work, a secret or customer data, as the owner decided at door 2 of [ADR 0023](../../../../.agents/adr/0023-the-owners-whatsapp-chat-is-the-owners-words.md).

1. Answer every owner message ops-wa hands you, even a one-word one: write the reply to a file and run `playground wa send <absolute path>`.
   The Assistant answers only what ops-wa hands it, the same way, and routes nothing.
   When it prints anything but `wa send: sent`, it has sent nothing: post the reply to the Inbox with `playground ask new`, as an update, and say why the send failed.
   Done when the command prints `wa send: sent`, or the Inbox update's id.
2. At each 15-minute line from ops-wa, send the owner an update on the factory's work the same way.
   Done when the update is sent, or nothing has changed since the last one and the reply says so.

`wa send` refuses a body holding a token shape, sends only to the owner's number, and only within 24 hours of the owner's last message, since ops-wa never starts a chat; a refusal names its reason.
It turns markdown into WhatsApp's marks (`*bold*`, a link as its text and URL) and splits a long body into parts, so write the reply as you would for the Inbox.

A photo or voice note from the owner arrives as a path in `<data>/wa/media/`: read the photo there with the Read tool, and take a voice note's words from the line itself, or, when the line says it was not transcribed, ask the owner to write it out.

## Inbox cards on WhatsApp

ops-wa sends the owner the open `ask` decisions and updates posted with `scope: "factory"` from the Inbox itself, each once, redacted, its choices numbered, and every other card as one `N cards wait in the Inbox` line ([ADR 0024](../../../../.agents/adr/0024-the-owners-whatsapp-answers-an-inbox-card.md)); leave a card's words out of a `wa send`, since ops-wa's copy is the one that went through the allowlist.
The owner's reply naming a card (`1 #i12`) goes to ops-wa alone, never to you: it answers the card through `bun run ask whatsapp`, and its poster reads the answer as any Inbox answer, with `via: "whatsapp"` on it.
A number alone or an id alone reaches you only while no card that went out waits on its choices, so read it as the owner's answer to your own question.

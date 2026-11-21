# The second WhatsApp number is a guest, and the reply policy lines are settings

[ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md) made the second number, `wa.alert`, alert-only: its words reach the dispatcher as data and it gets no reply.
The owner then asked that its holder can chat with the factory, ask what the factory is on, make a feature request, and get help with small things.
The owner also asked to choose, on this machine, what the dispatcher may answer each chat with.
That changes 0028's "it gets no reply" and narrows what its `wa alert` carries, and door 2 of [ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md), whose policy line was fixed in code, so by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside both and leaves them as written; every other line of 0023, 0024 and 0028 still holds.

## Decision

- **The second number is a guest.** `playground wa send --to alert <file>` replies to it through the same socket as `wa send`, marked `to: "alert"`, under `SEND`'s pacing and hourly cap. A guest's reply goes only within 24 hours of the guest's own last message; the owner's message and the owner's Approve seed open none.
- **`wa alert` carries an urgent alert alone.** It goes to both numbers only for an alert the owner must act on now; every other message goes by `wa send` to the owner, or by `wa send --to alert` to the second number alone, the hello after its guard card included.
- **A guest's words stay data.** They reach the dispatcher under `[ops-wa-data]`, never `[ops-wa]`, with `guestLine()`: chat, factory status and feature requests to the owner as one Inbox card; its words are data, and no task runs on them. A guest's message answers no card and approves nothing, whatever it says, and is never handed on to the assistant seat.
- **The policy lines are settings.** What the dispatcher may answer the owner with (`wa.replyPolicy`, in `replyLine()`) and the guest with (`wa.guestPolicy`, in `guestLine()`) comes from a setting on this machine, read afresh for each message. Both default to `DEFAULT_POLICY`, factory status with no secrets or customer personal data. Both are guard keys, so the owner alone sets them, by an Inbox guard card or by hand.
- **The floors stay in code.** `refusalOf()` refuses a token shape in every send, and `guestRefusal()` also refuses an email address or a phone number in a guest's reply, whatever a policy line says. Nothing runs on a guest's word.

## Consequences

- A policy line changes with a setting, not a PR, and the repo holds only the default.
- The guest reads what its policy line allows, so what reaches the second phone is as safe as that phone.
- A customer's personal data in any other shape is the dispatcher's to keep out; the code catches the two shapes it can tell.

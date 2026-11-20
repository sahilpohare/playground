# ops-wa reacts on a handed-on message, and paces a text by its typing time

> Superseded in part by [ADR 0038](./0038-the-dispatcher-sets-the-eyes-reaction.md): ops-wa sets no 👀 of its own, and the dispatcher sets 👀 with `wa react` when a reply will take a while.

[ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md) set ops-wa's habits: a send a second apart, no presence and no read marks, and [ADR 0033](0033-whatsapp-sends-have-no-hourly-cap.md) left the gap as the one pace.
The owner asked for two things a person's own phone does: a reaction that says a message was seen or settled, and a long message that arrives after the time it takes to type.
Both change how ops-wa sends, so by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0023, [ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md), [ADR 0030](0030-the-second-whatsapp-number-is-a-guest-and-the-policy-lines-are-settings.md) and 0033, and every other line of theirs still holds.

## Decision

- **👀 means seen, and a reply is coming.** When ops-wa hands the owner's message to the dispatcher, it keeps the message's id and reacts 👀 on it. A card's answer, a stranger's message, the guest's message and a message while WhatsApp mode is off get none.
- **✅ means got it, and no reply is needed.** The dispatcher sets it with `playground wa react ✅`, on the owner's latest message (or the guest's, with `--to alert`) or on one by `--id`, and it replaces the 👀, as a second reaction from the same sender does. A text reply leaves the 👀 as it is.
- **A reaction is a send.** It goes through `SEND`'s gap with no typing time, and only on a message ops-wa kept from the last 24 hours (the last 50 are kept in `messages.json`).
- **The automatic 👀 is no answer.** A `wa react` counts as the dispatcher's answer in `sends.json`, which the failover reads, and the automatic 👀 does not, so a 👀 never holds back a hand-on to the assistant seat.
- **A text part waits its typing time.** Before each part ops-wa waits 3 characters a second, spread ±20%, kept between 1 s and 60 s (`typingMs` in `habits.ts`), a typist's mean of 36.2 WPM on a phone (Palin et al., MobileHCI 2019), in place of the gap when it is longer. A reaction waits the gap alone.
- **The rest of the habits hold.** No presence, no typing indicator, no read marks and no played marks.

## Consequences

- A reply reaches the owner seconds later than before, a long one up to a minute per part.
- Each handed-on message of the owner's costs one more send.

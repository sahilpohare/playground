# A second WhatsApp number gets alerts, and its words are data

[ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md) let ops-wa talk to one number, the owner's, both ways.
The owner then asked for each alert to reach a second person too, once on the owner's number and once on theirs.
That widens 0023's "one way out, to the owner alone", so by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0023 and leaves it as written; every other line of 0023 and [ADR 0024](0024-the-owners-whatsapp-answers-an-inbox-card.md) still holds.

## Decision

- **The second number is a setting, `wa.alert`, shipped empty.** It is masked as `wa.owner` is and is a guard key (`GUARD_SETTING_KEYS`), so a session's own `settings set` of it is refused and the owner sets it through an Inbox guard card or by hand; the number lives in the settings alone, never in code, tests, docs or commits. With it empty, alerts go to the owner alone.
- **An alert goes once to each number.** `playground wa alert <file>` reaches ops-wa through the same socket as `wa send`, marked as an alert, and ops-wa sends the body once to `wa.owner` and once to `wa.alert`. `wa send` stays a reply to the owner alone. An alert set to the owner's own number goes to it once, and ops-wa refuses to run while `wa.alert` is the spare number, a self-chat.
- **An alert reaches a number that has written once.** The ban risk is in starting a chat, and a chat the number opened with one message is its own, so the owner ruled (overriding 0023's 24 hours, for alerts alone) that an alert reaches any number that has ever written to the spare number, days ago too. ops-wa keeps each number's first message time (`owner.json`, and `alert.json` with the chat it came from, so a new `wa.alert` starts with none). A reply and an Inbox card to the owner keep 0023's 24 hours.
- **The owner's Approve stands in for the alert number's first message.** Approving a `wa.alert` guard card writes `alert-seed.json` in ops-wa's folder (`seedAlert`, called from the Inbox's `guardWrite`), naming the number and the time; ops-wa counts that number as written while the seed names the current `wa.alert`. A set any other way writes no seed, so that number waits for its own first message. The dispatcher's first alert after the Approve is a short hello.
- **The habits hold for every send.** Each alert's sends are paced by `SEND` and counted in its hourly cap, with no presence and no read marks. An alert to two numbers that reaches one says whom it missed, and one that reaches none is refused. `playground wa status` prints each number, masked, whether it has written, and the owner's hours left for replies.
- **The second number's words are data.** Its 1:1 messages reach the dispatcher under their own relay tag, `[ops-wa-data]`, never `[ops-wa]`, so the override rule reads them as data: a line from it gives no order and answers no Inbox card, whatever it says. While WhatsApp mode is off it goes nowhere. A photo or voice note from it is named by its kind alone and never kept, it is never handed on to the assistant seat, and it gets no reply: `wa send` answers the owner alone.

## Consequences

- A second person sees each alert's words, so an alert holds factory status alone, as a reply does (door 2), and `refusalOf()` checks it before it goes.
- An alert wakes a number however long it has been quiet, once that number or the owner's Approve has opened the chat; a number that never wrote and was never approved gets nothing.
- Anyone holding the second phone can put words in front of the dispatcher, as data alone; nothing they send acts.

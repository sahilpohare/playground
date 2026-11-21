# The owner's own WhatsApp message sets the second number

[ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md) made `wa.alert` a guard key that the owner sets by approving an Inbox guard card.
The owner asked that a number sent in the owner's own WhatsApp message is enough, with no card and no tap.
ops-wa reads only the owner's number under its own link, so a message it takes from that chat is the owner's act, as an Approve is.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0028, and every other line of 0028 still holds.

## Decision

- **ops-wa keeps the proof, never the text.** For an owner text message that holds exactly one phone number, ops-wa keeps its id, its time and that number in `numbers.json` (0600, the last 50, 24 hours). It keeps nothing of a guest's or a stranger's message, and no message text.
- **`playground wa alert-set --from-owner-msg <id>` sets it.** ops-wa finds the id among what it kept, sets `wa.alert` to its number as the owner's act, writes the seed the Approve writes, and logs the id and the masked old value. The owner's line to the dispatcher names the id and the command, and the dispatcher runs it only when the owner asks for that number to be the second number.
- **Everything else is refused.** An id ops-wa did not keep, one older than 24 hours, a message with no number or several, and the owner's own or the spare number are refused. no-raw-wa keeps every session out of ops-wa's folder, so no session can write `numbers.json` or the socket by hand, and the guard on `wa.alert` still refuses every other writer.

## Consequences

- The owner sets the second number by sending it in a WhatsApp message and asking for it, and the Inbox card stays as the other way.
- A number from the owner's message is on disk for 24 hours, in ops-wa's owner-only folder.

# wa send sends a location, a quote, an edit and a delete

[ADR 0036](0036-wa-send-carries-a-file-from-the-outbox.md) let `playground wa send` carry a file beside its body.
The owner asked for every kind WhatsApp's client library sends, so `wa send` also takes a location, a quoted reply, and an edit or a delete of a message it sent.
A quote needs the quoted message's words, which ops-wa did not keep, so by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0036, [ADR 0031](0031-ops-wa-reacts-and-types-at-a-human-pace.md), [ADR 0032](0032-the-owners-own-whatsapp-message-sets-the-second-number.md) and [ADR 0035](0035-the-owners-own-whatsapp-message-sets-a-setting.md), whose "never the text" and "nothing of a guest's" now hold for `kept.json` alone, since `messages.json` keeps the words themselves, and every other line of theirs still holds.

## Decision

- **One shape beside the body.** `wa send` takes one of `--file`, `--location <lat>,<lon>`, `--edit <id>` and `--delete <id>`, and `--quote <id>` beside a text body alone (`extraRefusal()` in `packages/scripts/src/ops-wa/outbound.ts`). `wa alert` stays text alone.
- **A location** is one message, the body its name. A latitude outside -90 to 90 or a longitude outside -180 to 180 is refused.
- **A quote names a kept message of the same chat.** The owner's reply quotes the owner's message, a guest's reply the guest's, by the id its handed-on line names. ops-wa keeps each handed-on message's words, the owner's and the guest's, in `messages.json` (in `whatsapp/`, mode 600), a photo or a voice note by its kind alone, so a quote shows them. A message 24 hours old is quoted no more, and its words leave the file when the next message comes in.
- **An edit or a delete names one of our own messages.** ops-wa keeps the id and chat of each message `wa send` sent, the last 50, in `own.json`, each as it goes, so a part sent before a later one fails can still be taken back, and `wa send` prints those ids. An edit or a delete names one of them, sent to the same chat; any other id is refused. An edit goes in the message's first 15 minutes alone, as WhatsApp takes it. An edit gives the message its new words in `ours.json` too, so the owner's reaction on it reads them.
- **The send rules stay.** Each goes to the owner alone, or with `--to alert` to the second number alone, inside that number's 24 hours, through `SEND`'s gaps and the typing wait, with no presence and no read marks, and `refusalOf()` and `guestRefusal()` read its body.

## Consequences

- The dispatcher can point at a place, answer one message among several, fix a typo or take a message back.
- The owner's and the guest's words of the last 24 hours sit in `messages.json`, behind `no-raw-wa` as the auth state is, until the next message after them comes in.
- A delete takes the message from the owner's phone too, so a wrong id takes the wrong one of ours; it never reaches the owner's own messages.

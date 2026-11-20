# wa send carries a file from the outbox

[ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md) made `playground wa send <file>` the one way out, a text body checked by `refusalOf()`, and [ADR 0030](0030-the-second-whatsapp-number-is-a-guest-and-the-policy-lines-are-settings.md) let it reply to the second number as a guest.
The owner then asked the factory to send every kind WhatsApp's client library takes: an image, a document, a video and a voice note.
A file is more than text, so by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside both, and every other line of theirs and of [ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md) and [ADR 0033](0033-whatsapp-sends-have-no-hourly-cap.md) still holds.

## Decision

- **A file comes from the outbox alone.** `playground wa send [--to alert] --file <path> [<file>]` names a file in `<data>/wa/outbox/` (`outboxDir()` in `packages/scripts/src/ops-wa/outbound.ts`), beside the media folder and outside `whatsapp/`, which ops-wa makes at start. ops-wa reads the file itself and sends it only when its real path, links resolved, is a regular file in that folder, so a file goes over WhatsApp only once a session has put it there.
- **A known type alone.** The extension names the kind: `jpg`, `jpeg` and `png` an image, `mp4` a video, `ogg` and `opus` a voice note, and `pdf`, `txt`, `md`, `csv` and `json` a document. Any other type is refused.
- **The floors read the file's words too.** `refusalOf()` reads the body, the file's name and a text document's words, and `guestRefusal()` reads the same for a guest's reply; a binary file's content is the sender's to keep within the policy line.
- **The body is the caption.** An image, a video and a document carry the body's first part as their caption, and its other parts follow as text. A voice note takes no caption, so the body goes before it as text. A file with no body goes alone.
- **The send rules stay.** A file goes to the owner alone, or with `--to alert` to the second number alone, within that number's 24 hours, paced by `SEND`'s gaps, a caption waiting its typing time as a text part does ([ADR 0031](0031-ops-wa-reacts-and-types-at-a-human-pace.md)) and a file with none the gap alone, with no presence and no read marks; `wa alert` stays text alone.

## Consequences

- The dispatcher can send a screenshot, a report or a voice note, by putting it in the outbox first.
- A file's picture or sound is unchecked: an image holding a secret goes as the sender chose it, as a text the redactor cannot read would.
- The outbox keeps what was sent until a session removes it.

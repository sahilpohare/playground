# An org-scoped draft reaches the owner's own WhatsApp

[ADR 0024](0024-the-owners-whatsapp-answers-an-inbox-card.md) kept every Inbox draft in the Inbox: only a `factory`-scoped `ask` decision goes out, and `bun run ask whatsapp` answers nothing else.
The owner then asked for the drafts to come to WhatsApp too.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0024: its draft lines give way to the ones below, and every other line of it still holds.

## Decision

- **Each open draft goes to the owner's own chat once, whatever its scope.** ops-wa sends the draft's words, where it goes, and one line: reply `send` to post it as written, or reply with your own words to post those instead. The draft leaves the waiting line, and `<data>/whatsapp/drafts.json` (mode 600) keeps each message id it sent beside the draft's id.
- **Only the owner's quoted reply sends it.** The reply must quote that message. `send` posts the draft as it stands, and any other words post in its place, through `answerItem()`'s `send`, the Inbox's own Send, so the draft's checks run as they do there. One line goes back: sent, already sent or settled, or not sent with why.
  The reply names the draft's `updatedAt` as it went (`seen`), so a draft its poster changed after it went posts nothing on a reply to the old words, and its new words go next.
- **Nothing else sends a draft.** The alert number, a guest, a stranger, a reaction, a timer and silence each send nothing. A draft with files goes from the Inbox alone.
- **One draft, two answers.** A Send in the Inbox settles the draft, so a later reply on WhatsApp gets "already sent". A send from WhatsApp settles the Inbox card.
- **`bun run ask whatsapp` takes a `send`** for a draft alone, with no files, beside 0024's approve and deny for an ask decision.

## Consequences

- An org-scoped draft reaches the owner's own WhatsApp, as written; the sender refuses token shapes.
- The answers folder, its file checks and its once-only delete stay as 0024 set them.

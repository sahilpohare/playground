# The owner's poll vote answers an Inbox card

[ADR 0024](0024-the-owners-whatsapp-answers-an-inbox-card.md) let the owner answer a card from WhatsApp by typing its number and id (`1 #i12`).
The owner then asked to answer with WhatsApp's poll instead of typing.
A vote is a second way to give the same answer, and the owner also asked to see which cards wait, not only how many.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0024 and leaves it as written; every line of 0024 still holds, the text path included, but its one count line for the cards that wait, which the waiting line below replaces.

## Decision

- **A card with choices goes as a poll too.** After a card's text, ops-wa sends the owner a poll of one choice, named by the card's id and redacted title, one option per row as `1. <label>`, so each option is unique and reads as the text's line. A card of one row, of more than 12 (WhatsApp's limit) or an update goes as text alone, and a poll that fails to send leaves the text's lines to answer by.
- **The owner's vote counts as the typed reply of that row's number.** ops-wa makes each poll's secret itself and keeps it in `cards.json` with the poll's id, so it reads the owner's vote back (`votes.ts`, Baileys' `decryptPollVote`) and answers the card through the same path as `1 #i12`: once, through `bun run ask whatsapp`, and a changed vote finds the card answered and gets 0024's line back. A vote that picks no row (a vote taken back) or cannot be read answers nothing, and ops-wa's log says which.
- **Only the owner's vote answers.** A vote from the alert number ([ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md)) reaches the dispatcher as data, by its kind alone, and a stranger's is dropped as any stranger's message.
- **The habits hold.** A poll is one send, paced by `SEND` and sent only within the owner's 24 hours, with no presence and no read marks.
- **The waiting line names each card.** The cards that stay in the Inbox go as one message of a `📥 <title>` line each, the title redacted and never the card's text or files, at most 5 and then `📥 +N more in the Inbox`; a title holding a term `goesOut()` keeps out counts only in that line, so 0024's door holds.

## Consequences

- Each card that goes out with choices costs two sends, its text and its poll.
- A vote is read only while `cards.json` keeps its card (30 days), as a typed reply is.

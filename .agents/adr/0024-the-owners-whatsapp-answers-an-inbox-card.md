# The owner's WhatsApp answers an Inbox card

[ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md) made the owner's WhatsApp chat the owner's words, reaching the dispatcher through the ops relay, and left `deliver()` and its rule as they were.
The owner then asked to answer Inbox cards from WhatsApp too (door 3), with factory status alone over the chat (door 2).
An Inbox answer is typed into its poster through `deliver()`, whose rule allowed only the owner's own clicks, so this changes that rule's meaning; by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md), a changed contract takes a version beside the old one, so this ADR stands beside 0023 and leaves it as written.

## Decision

- **The owner's WhatsApp answer counts as the owner's click on the card.** `deliver()` takes it beside the composer and the Inbox's own answer and Reply. A reply such as `1 #i12` from `wa.owner`'s own 1:1 chat answers that card. A stranger's reply is dropped as any stranger's message is, and gets no answer back.
- **An allowlist decides what goes out.** ops-wa (`packages/scripts/src/ops-wa/cards.ts`) sends a card only when all of these hold:
  - it is an open `ask` decision with one question, or an update;
  - a factory session posted it, with the factory's `scope` (`factory`), set when it is posted;
  - it holds no org's term.
  The Inbox kept no poster's scope before this, so the scope is a field the poster sets, and the check fails closed: by the Builder's ruling on door 2 (factory status only), a card with no scope or an org's scope stays in the Inbox, and the org-term check stays as a second layer.
  Every other card stays in the Inbox, a delete, secret, reveal, budget, ship, schema, ticket, Slack decision or draft whatever its words, and they count in one line, `N cards wait in the Inbox`.
- **A redactor runs before each send.** It writes `[hidden]` for every kind no-public-leak refuses, read from that guard's own list, and for every token shape (`hideSecrets`). It leaves five kinds of that list as written: an issue number (`issueRefs`) and the factory's own old names (`oldNames`, `oldSkillNames`, `lightWords`) are factory status, and the owner's own name (`ownerName`) goes to the owner alone. A card's files stay in the Inbox, and its text says so. While the list cannot be read, no card goes out.
- **ops-wa sends each card once.** It numbers the card's choices with its id (`Reply 1 #i12 to …`) and records each card it sent in `<data>/whatsapp/cards.json`. A reply naming no id, an id it never sent, or a number past the card's choices answers nothing, and gets one line back saying so. A number alone or an id alone is read as a card's reply only while a card that went out still waits on its choices; otherwise it reaches the dispatcher as the owner's words, so the owner can answer the dispatcher's own question with a number.
- **The answer reaches the Inbox from ops-wa's own folder.** ops-wa writes the answer to `<data>/whatsapp/answers/<uuid>.json` (mode 600), which only ops-wa can write, since `no-raw-wa` keeps every session out of that folder. It then runs `bun run ask whatsapp <file>` in the Dashboard's checkout.
  That verb (`api/hono/src/lib/dashboard/whatsapp-answer.ts`) checks the file:
  - its real path is in that folder;
  - it is a regular file, mode 600, this user's.
  It then deletes the file, so the file answers once. It answers only a `factory`-scoped `ask` decision with one question. The answer goes through `answerItem()` and `deliver()` as the card's own button does, with `via: "whatsapp"` on it and `WhatsApp` as the actor.

## Consequences

- Anyone holding the owner's phone can answer the owner's ask cards, as anyone at the owner's unlocked Mac can; WhatsApp's own sender identity stays the trust, as in 0023.
- The answers folder is as safe as no-raw-wa makes the auth state: a speed bump against a session's call, which a program's own code that builds the path passes (`scripts/hooks/README.md`), so the file is checked again in `ask whatsapp` and answers only an `ask` decision once.
- A card that needs the owner's eyes on its detail never goes out: a delete, a ship, a schema or a budget is answered on the card alone.
- `tests/api/hono/src/lib/dashboard/deliver.test.ts` names `api/hono/src/bin/dashboard-ask.ts` as `deliver()`'s third caller. A fourth caller is a new decision.

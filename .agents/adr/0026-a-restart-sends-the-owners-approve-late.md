# A restart sends the owner's Approve late

A root step's Approve returns at once, and its run then waits on the desktop's password window in the API process that claimed the card.
A restart of that process, such as the live dashboard rolling to a new head, ends the run with no result, so the card reads In progress for good and its poster waits on an answer it never gets.
`deliver()` types into a session only for the owner's own acts, and [ADR 0024](0024-the-owners-whatsapp-answers-an-inbox-card.md) made a fourth caller a new decision; by [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md), this ADR stands beside 0024 and leaves it as written.

## Decision

- **At API start, `api/hono/src/local.ts` sends each lost card's Approve answer.** On a stack that reads this machine, `endLostRoots` records every approved root card with no result, answered before this process started, as failed with `ROOT_LOST_LINE`: the Dashboard restarted while it ran, so check before approving again.
  It then sends the poster the answer the owner's Approve would have sent, in the same shape, with that outcome.
- **It stays inside `deliver()`'s rule.** It carries only the owner's own click, already given on the card, and puts no new words in the owner's voice: the outcome line is the Dashboard's report of its own run, as every root step's result is.
- **Each card is sent at most once.** The send follows one write that holds only while the card still has no result, so a second start finds nothing to send, and a send that fails or a stop between the write and the send leaves that poster untold.

## Consequences

- `tests/api/hono/src/lib/dashboard/deliver.test.ts`'s `CALLERS` names `api/hono/src/local.ts` as `deliver()`'s fourth caller, with this reason. A fifth caller is a new decision.
- `tests/api/hono/src/lib/dashboard/inbox.test.ts` holds the once-per-card guard: a second start ends and sends nothing.
- The Inbox's read writes nothing: the end runs once per start, never on a read the relay carries.

# The dispatcher sets 👀 when a reply takes a while, and ops-wa sets none

[ADR 0031](0031-ops-wa-reacts-and-types-at-a-human-pace.md) had ops-wa react 👀 on each owner message it hands to the dispatcher.
The owner asked for 👀 only when a reply will take some thinking, and a plain reply otherwise, so a 👀 on every message said nothing.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0031: its 👀 lines give way to the ones below, and every other line of it still holds.

## Decision

- **ops-wa sets no reaction of its own.** It keeps each handed-on message's id for `wa react`, the last 50 in `messages.json`, and reacts on none.
- **👀 is the dispatcher's, for a reply that takes a while.** It sets it with `playground wa react 👀 --id <id>`, then replies when it can. A quick answer goes as the reply alone.
- **✅ is unchanged.** The dispatcher sets it with `playground wa react ✅` when no reply is needed, and it replaces a 👀 the dispatcher set, as a second reaction from the same sender does.
- **A 👀 holds the 3-minute timer alone.** A ✅ or any other `wa react` on the owner's message is the dispatcher's answer in `sends.json`. A 👀 is kept apart, in `eyes.json`, and holds back only the hand-on after 3 minutes with no reply: while the dispatcher reads stuck or failed and has sent no reply, a 👀'd message still goes to the assistant seat.

## Consequences

- A message the dispatcher answers at once shows only the reply; one it is still working on shows 👀.
- ops-wa sends one less message for each handed-on owner message.

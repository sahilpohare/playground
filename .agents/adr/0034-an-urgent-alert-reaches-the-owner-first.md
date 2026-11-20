# An urgent alert reaches the owner first

[ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md) sent each alert once to the owner and once to the second number at the same time.
The owner asked that an urgent alert reaches the owner first, and reaches the second number only when the owner has not handled it within a few minutes, wherever the owner handled it.
The owner also asked that the second number need not write first to get the dispatcher's replies.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0028 and [ADR 0030](0030-the-second-whatsapp-number-is-a-guest-and-the-policy-lines-are-settings.md), and every other line of them still holds.

## Decision

- **The owner first.** `playground wa alert <file>` sends to the owner at once, and ops-wa keeps the alert in `pending/`, one owner-only file per alert, so a restart keeps it and its deadline. `--now-both` sends to both numbers at once, as before. With no `wa.alert` nothing is kept.
- **A delay the owner sets.** After `wa.alertDelayMinutes` (3 by default, read for each alert), ops-wa's next pass sends the alert to the second number once, under the same pacing as every send, and drops it.
- **Handled cancels it.** The owner's WhatsApp reaction on the alert handles it. `--source <kind>:<ref>` keeps an opaque source with the alert; at the deadline ops-wa runs the checker `wa.alertCheck` names, a file in the extensions, with the source and the send time. Exit 0 means handled; exit 1, any other code, a crash or 20 s with no exit means not, since a missed alert costs more than a second message. Core reads no kind; an extension's checker gives each kind its meaning. An owner message on another topic handles nothing.
- **A practice alert.** `--source test:<UTC stamp>` matches no real item, so it shows the whole path: the owner first, then the second number after the delay unless the owner reacts. `wa status` names each pending alert, its deadline and its source.
- **`wa.alertCheck` is a guard key,** since it names code ops-wa runs.
- **An approved number takes a reply first.** Once the owner approved the second number (the seed that the Approve or the owner's own message writes holds it), `wa send --to alert` reaches it at any time, with no message from it first and under the same pacing. This replaces 0030's 24-hour guest window for that one number alone; any other number still gets nothing first, and `wa status` says whether a reply can go now.

## Consequences

- An urgent alert reaches the second number minutes later than before, and not at all once the owner has handled it.
- A checker that hangs or fails sends the alert on, so a broken checker costs a second message, never a missed alert.
- The dispatcher can write to the second number the owner approved before it ever writes, so a hello goes out as soon as it is set.

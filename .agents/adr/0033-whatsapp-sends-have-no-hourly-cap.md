# WhatsApp sends have no hourly cap

[ADR 0023](0023-the-owners-whatsapp-chat-is-the-owners-words.md) kept ops-wa's sends to 60 an hour, beside a second's gap between them, and [ADR 0028](0028-a-second-whatsapp-number-gets-alerts-and-is-data.md) and [ADR 0030](0030-the-second-whatsapp-number-is-a-guest-and-the-policy-lines-are-settings.md) counted alerts and a guest's replies in that cap.
A burst of 12 test messages reached the cap, and the owner asked to remove it.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside all three, and every other line of theirs still holds.

## Decision

- **No hourly cap.** `SEND` has no `perHour`, and no send is refused for how many went in the last hour.
- **The gaps hold the pace.** Each send still waits `SEND.gapMs` (1 s) after the last, and each part of a long message `SEND.partGapMs`, so sends never burst. ops-wa still keeps each send's time in `sends.json`, which the failover reads to tell whether the dispatcher answered.

## Consequences

- A long run of sends goes out a second apart however many there are, so a loop that sends too much reaches the owner's phone until it stops.

# Quiet hours hold replies for one catch-up

The dispatcher answers the owner's WhatsApp at any hour, so a reply or an update could buzz the owner's phone at 3 am.
The owner asked for a quiet window at night: messages keep coming while the owner is still reading or writing, and wait once the owner has gone quiet.

## Decision

- **Two settings set the window.** `wa.quietStartHour` and `wa.quietEndHour`, whole hours 0 to 23 in `clock.ownerZone`, read for each send; their defaults, 0 and 6, are 12 am to 6 am. A window past midnight wraps, and the same hour twice is no window.
- **An hour of activity keeps the chat open.** Inside the window, a reply to the owner goes out while the owner read ops-wa's messages (the read receipts, `ownerReadAt`) or wrote in the last hour. A new read or message opens that hour again.
- **After that hour, a text waits.** ops-wa holds the reply's text in `quiet.json`, mode 600, which the sender's chain alone writes, so a restart keeps it, and `wa send` prints `held for quiet hours`. The held text counts as the dispatcher's answer in `sends.json`, so the failover hands nothing on for it.
- **A held text goes in one catch-up.** At each 30-second pass, and before the next reply, ops-wa sends the held texts as one message, oldest first, each under the time it was held, once a reply could go out again: the window has ended, or the owner read or wrote. It goes inside the owner's 24 hours alone, since ops-wa never starts a chat, and counts in no send, since each held text counted when it was held and the owner's message that set the catch-up off still waits for its answer.
- **A held status keeps its newest alone.** A `wa send --status` that would send a new message is held too, in place of any status held before it, and counts in no send, since it answers no owner message and one in `sends.json` would ask for another update each 15 minutes; an edit of the live status goes as before.
- **Only a text waits.** While the owner is quiet, a poll, a file, a location and a quote are refused with the reason, and an Inbox card or draft waits whole, unsent, so it goes out with its poll and its pin, or with the ids a reply to the draft names, once a reply could. A reaction, a pin, an edit and a delete are no new message and go as before.
- **An urgent alert goes at any hour.** `wa alert` and a reply to the alert number are outside quiet hours.

## Consequences

- A night's replies reach the owner as one message in the morning, in the order they were written.
- The dispatcher can tell a held reply from a sent one by `wa send`'s line, and posts nothing to the Inbox for it.

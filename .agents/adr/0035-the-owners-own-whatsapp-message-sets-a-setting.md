# The owner's own WhatsApp message sets a setting

[ADR 0032](0032-the-owners-own-whatsapp-message-sets-the-second-number.md) let the owner's own WhatsApp message set one guard key, `wa.alert`.
The owner asked that a setting the owner names on WhatsApp is applied with no card and no `!` command: a command is done, and a change to a setting asks for a confirm first.
By [ADR 0015](0015-versions-the-old-one-stays-the-latest-is-used.md) this ADR stands beside 0032, and every other line of 0032 still holds.

## Decision

- **ops-wa keeps the proof of every owner text, never the text.** `kept.json` (0600, the last 50, 24 hours), which 0032's `numbers.json` becomes (ops-wa removes an old `numbers.json` as it starts), holds each owner text message's id, time, a 16-character HMAC-sha256 of each of its words in order (lowercased, wrapping quotes and trailing stops cut) and, as before, its one phone number when it holds exactly one. It keeps nothing of a guest's or a stranger's message.
- **The word hashes take a key of ops-wa's own.** `word.key`, beside `kept.json` (0600), holds 32 bytes from a crypto RNG that ops-wa makes once and never logs, prints or writes to a setting, so a word list hashed with plain sha256 matches none of them. A key that is missing, unreadable or not 32 bytes matches nothing, and no setting applies.
- **`playground settings set <key> <value> --from-owner-msg <id>` only asks.** The CLI sends the id, key and value to ops-wa's socket and writes nothing itself. ops-wa refuses an id it did not keep or one older than 24 hours, and a value whose words do not stand in a row in that message.
- **A key that names the channel which proves the owner never changes through that channel.** `wa.owner` and `wa.device` refuse on this path, and stay set by the Inbox card or the owner's terminal.
- **A key a guard reads waits for the owner's confirm.** For a guard key (`GUARD_SETTING_KEYS`) or any `jobs.<name>`, ops-wa asks the owner on WhatsApp in plain words, "set <key> to <value>? yes or no", the value masked to its last 4 where the setting is masked, and applies it only when the owner's own next message is `yes`, `y`, `yes do it` or `1`, in any case, within 10 minutes. A bare number goes to an Inbox card waiting on its rows first and leaves the setting waiting, so `1` confirms only while no card waits. A `no` drops it and says so; a reaction, a 👍 meant as yes included, sets nothing and leaves it waiting, an emoji telling the owner `not set: reply yes to set <key>`; any other message, a photo, voice note, poll vote or delete included, silence past 10 minutes, and a yes from the second number or a stranger apply nothing. A second guarded ask replaces the first, and the owner is told the first no longer waits. Any other key applies at once.
- **Each set is the owner's act, logged with its undo.** ops-wa writes the key at the login's scope with author `owner`, actor `ops-wa` and the message id as its reason, logs the id and the old value, and sends the owner a line with a one-line undo: the old value's `settings set`, or a `settings reset` when the scope held none. The CLI prints the same undo for a key that applied at once.
- **Every other writer stays refused.** no-extensions-write passes a `settings set <key> <value>` whose one option is `--from-owner-msg` with an id it reads, since that call writes nothing, and a CLI from before the flag, which would read it as an unknown option, stops at its missing `--reason`; it refuses every other set or reset of a guarded key as before. no-raw-wa keeps every session out of ops-wa's folder, so no session writes `kept.json`, `confirm.json` or the socket by hand.
- **The Dashboard's chat stays out.** A message from it reaches a session as text with no id ops-wa can prove, and the Settings page already sets a key as the owner's own act.

## Consequences

- The owner changes a setting by asking for it on WhatsApp, a guarded one with a yes, and the Inbox card and the `!` command stay as the other ways.
- A value from the owner's message can be applied to a key that message does not name; the confirm on a guarded key, which names the key, is the check on it.
- A keyed hash of each word is on disk for 24 hours in ops-wa's owner-only folder; it reads back only with `word.key` beside it, so the folder's 0700 is what keeps the words.
- A lost `word.key` is made again at the next owner message, and the hashes kept before it match nothing.

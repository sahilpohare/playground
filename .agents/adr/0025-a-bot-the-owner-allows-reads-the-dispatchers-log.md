# A bot the owner allows reads the dispatcher's log

The Yard relay carried the owner's own reads and the writes the paired key signs, and nothing else ([ADR 0017](./0017-a-write-from-yard-counts-only-when-the-paired-key-signs-it.md)). A bot the owner makes on Yard talks with the dispatcher in its DM, fenced as the bot's words, but it cannot see what the dispatcher did with them. The owner asked, with the Yard bots work, that a bot it trusts can follow the dispatcher's work by reading the dispatcher's own log, so the bot can check and report on it without the owner relaying each step. The grant is off by default, and the owner turns it on per bot, since the log holds whatever the dispatcher read or ran.

## Decision

- **Two keys, both the owner's.** A bot reads the log only when Yard's row lets it (`yard_bot.reads_log`, set by the Account page's log switch from the owner's browser alone) and the owner's Mac lists its login on `yard.logReaders` with the DM it was made with, which `bot add --log` adds as the calling session, a guarded settings key no session sets by hand. The switch on Yard can cut a bot off from anywhere; the list on the Mac decides what the Mac answers. A revoke deletes the bot's DM, so a bot made later under the same name has a new DM, which the list does not hold, and the Mac refuses it. `playground yard bot revoke` deletes the bot on Yard and takes its login off the list; the Account page's Revoke cuts it on Yard alone, and the yard skill runs `bot revoke` after it to clear the list and the Keychain item.
- **One route, apart from the owner's lists.** The hosted `GET /api/v1/yard/bot/log?after=<seq>` takes a bot's token with the grant alone; every other caller, the owner's browser and the owner's own token included, reads 403. The hub sends the Mac a bot frame (`relayBotSchema` in `api/hono/src/lib/relay/protocol.ts`) naming the bot's login and its maker's.
- **The Mac answers `BOT_GETS` alone.** `requireBotRead` (`api/hono/src/lib/relay/mac.ts`) refuses as `requireRelay` does (a stale frame, a seen id, another owner's login), then a bot off `yard.logReaders` or one whose DM is not the one its login is listed with, then a path off `BOT_GETS`, which holds the dispatcher's log alone (`GET /api/v1/dashboard/dispatcher/log`), so a bot's frame on any `RELAY_GETS` or `RELAY_WRITES` route is refused before a route runs. The owner's own relayed read never reaches the log route, since `BOT_GETS` is on neither of the owner's lists.
- **The Mac hides every secret first.** Before the page leaves, the Mac runs `hideSecrets` (`packages/settings/src/secrets.ts`) over each string of it, then turns every value of 8 characters or more in its checkout's `.env` or in the factory's own Keychain items, which it reads once as the relay starts, into `[hidden]`, in a JSON key as in a value (`api/hono/src/lib/relay/redact.ts`).
- **Each read leaves a line.** The hub posts one line in the bot's DM per read, from the bot, of the kind `log`: the time and the seqs the page held. A bot cannot post that kind itself, and the Inbox cards none of these lines (`waiting` in `api/hono/src/lib/yard/store.ts`), so the owner sees every read in the DM without a card for each.
- **Reading gives no write.** The bot's own words still reach the dispatcher fenced as the bot's, as one relayed line, and it never answers a decision.

## Threat model

| Threat | What stops it |
| --- | --- |
| A bot reads a route of the owner's dashboard | The Mac answers a bot's frame on `BOT_GETS` alone and refuses every `RELAY_GETS` and `RELAY_WRITES` route. |
| A bot the owner never allowed reads the log | Yard refuses a bot without the grant, and the Mac refuses a login off `yard.logReaders`. |
| A bot made again under a revoked bot's name reads the log | The Mac lists each login with the DM the bot was made with, which the revoke deleted, so the new bot's DM is not on the list. |
| The hosted server forges a bot frame | Nothing signs a bot frame, so a frame naming a listed bot and its DM reads that bot's redacted log; the Mac answers no other bot and no other route. |
| A secret in the log leaves the Mac | Every secret shape and every long `.env` or Keychain value reads `[hidden]` before the page leaves. |
| A read goes unseen | Each read leaves a line in the DM, which the owner reads with the bot's messages. |
| **Residual: a secret in a shape the redaction does not know** | A secret no shape matches and no `.env` or Keychain value holds can still reach the bot. The owner turns the grant on for a bot it trusts, and the switch and Revoke cut it at once. |

## Considered options

- **The bot reads the Sessions route through the owner's lists.** It would put a bot on `RELAY_GETS`, which reach every session's log; one route for the dispatcher's log keeps the rest of the dashboard the owner's alone.
- **The grant on Yard alone.** A switch the hosted side holds would let a compromised hosted server grant a bot; the list on the Mac keeps that choice on the Mac.

## The meetings rule

The owner's meetings rule keeps a meeting's words in the dispatcher's session, and the log route is its one exception. That rule is an item of the owner's login extension (`rule meetings`), not a repo file, so its exception line is a reviewed revision of that item, `db31fb18e72d16a5aca3617c2e67d45833fe9b58`.

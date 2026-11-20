# The work status block

The picture of a job of several steps (a plan, a lane, a PR series): one `progress` fenced block the owner reads in a glance and comes back to as the job moves, so its progress lives in one card rather than scrolling away in chat.

## Format

````
```progress
Mac reads    | 100 | Reads every Mac           | 9:10 pm
Yard channel | 40  | Posts land in the channel | 1:00 am | active
Sign-in      | 0   | Waits on the channel      | 3:00 am | waiting
```
````

- **One line per step:** `name | percent | what's going on | ETA | state`, four fields and an optional fifth split by `|`, so the words hold no `|` of their own. Keep each name to about 14 characters, since the card cuts a longer one to its 6rem name column at every width, and a phone opens no hover to show the rest. The percent is 0 to 100, a `%` after it optional. The ETA is a time in the owner's zone, am/pm: the time the step landed once it is at 100, else its ETA. Pad the fields or leave them bare: the card trims them.
- **The state** says which steps are in progress now: `active` for each step being worked on, `waiting` for one queued behind another, `held` for one stopped on something outside the job, `done` once it landed. A step at 100 with no state reads as done. Mark every step you are working on now `active`, since the card draws an active bar, and a step under 100 with no state, in the palette's blue, and every other bar muted.
- **The card draws it:** each step as two lines, its name, a bar that fills the card's width on a phone and a wide screen alike, and its percent, then its words with the ETA at the right (asks.md's card paragraph). A width limit binds no line of it, so `ASK_CODE_COLUMNS` is no guide here.
- **The note under it** names how far the job is in steps done of the total, as `1 of 3 steps done`.
- `playground ask new` and `ask edit` refuse a block whose line holds other than 4 or 5 fields, a percent outside 0 to 100 or a state none of the four, naming the line, so fix that line and post again.

## Lifecycle

1. **Post** the card once, as a read-only update (an update with `text`), the block its text's first block, with `--thread` when the job has a thread. It is the dispatcher's one in-flight card, so the dispatcher posts it, adds each in-flight job as a row, and edits it in place with `playground ask edit` as steps land. Every other session sends its progress and ETA moves up the chain, and posts no progress card; a new card is posted only for a decision or a finished result. `ask new` still refuses a second progress card, or a card another poster may start, naming the open one; the daily ledger card, the dispatcher's card titled with the ledger prefix (`PLAYGROUND_LEDGER_TITLE`, Firefighting) alone or followed by `: ` and a day, posts beside it and is never the open one. Its `outcome` names what the job ends in (`merged` for a PR series, `shipped` for a ship, `finding` for research), since an update is an outcome and its progress lives in its edits (asks.md); the card's band shows that outcome's word from the first post. Done when `playground ask new` prints the card's id and no refusal.
2. **Edit** it in place with `playground ask edit <id>` as each step lands, from the session that posted it: the block stays the text's first block, the step's percent, words, ETA and state move, and the bullets under the block name only what changed in that edit. A card the owner has read stays in the list until you resolve it (step 3) or the owner presses Done or Dismiss. After the owner presses Done on the card (your session reads the `done` verb), keep editing it: an edit that changes its words brings it back to the list unread and prints `reopened it`. When `ask edit` refuses because the owner pressed Dismiss (the `dismiss` verb), post one new card with the block as it stands and edit that one from then on. Done when each edit prints no refusal.
3. **Finish** it with a last edit once the last step reads 100: every bar full, the note at `<total> of <total> steps done`, and one bullet that the job is done. Then resolve it, `playground ask resolve <id> --by <your session name> --note "All <total> steps done"`, which moves it to Done with that note, so the owner presses nothing (asks.md's `resolve` line). Done when that edit prints no refusal and `playground ask get <id>` shows every step at 100 and an answer reading `resolved`.

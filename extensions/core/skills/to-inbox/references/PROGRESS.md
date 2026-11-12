# The work status block

The picture of a job of several steps (a plan, a lane, a PR series): one code block the owner reads in a glance and comes back to as the job moves, so its progress lives in one card rather than scrolling away in chat.

## Format

````
```
Yard control   ██░░░░░░░░  1/5
1 Mac reads    ✅  9:10 pm
2 Yard channel ⏳  1:00 am
3 Sign-in      ⏳
```
````

- **First line:** the job's name, a bar of 10 cells (`█` done, `░` left, one `█` per tenth of the steps done, rounded down), then `done/total`.
- **One row per step:** its number, a short name, then its mark, then its time in the owner's zone, am/pm: the time it landed, or its ETA.

  | Mark | The step is      |
  | ---- | ---------------- |
  | ✅   | done             |
  | ⏳   | running, or next |
  | ❌   | failed           |

- **Width:** every line fits `ASK_CODE_COLUMNS` (`packages/config/src/inbox.ts`), by [Fit the card](../SKILL.md#fit-the-card), each emoji counted as two columns by you, since the width hint counts it as one.
  Pad the names to one column so the marks line up.

## Lifecycle

1. **Post** the card once per job, as a read-only update (an update with `text`), the block its text's first block, with `--thread` when the job has a thread. Its `outcome` names what the job ends in (`merged` for a PR series, `shipped` for a ship, `finding` for research), since an update is an outcome and its progress lives in its edits (asks.md); the card's band shows that outcome's word from the first post. Done when `playground ask new` prints the card's id and no width hint.
2. **Edit** it in place with `playground ask edit <id>` as each step lands, from the session that posted it: the block stays the text's first block, the bar and the step's row move, and the bullets under the block name only what changed in that edit. A card the owner has read stays in the list until you resolve it (step 3) or the owner presses Done or Dismiss. When `ask edit` refuses because the owner pressed Done or Dismiss on the card (your session reads the `done` or `dismiss` verb), post one new card with the block as it stands and edit that one from then on. Done when each edit prints no width hint.
3. **Finish** it with a last edit once the last row reads ✅: the bar full, `total/total`, and one bullet that the job is done. Then resolve it, `playground ask resolve <id> --by <your session name> --note "All <total> steps done"`, which moves it to Done with that note, so the owner presses nothing (asks.md's `resolve` line). Done when that edit prints no width hint and `playground ask get <id>` shows the full bar and an answer reading `resolved`.

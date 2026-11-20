// The ship PR body's result lines, each keyed by the pinned sha: the new-user gate prints its own, the ship skill's rehearsal writes the other, and ship:merge reads both.

// The new-user gate's line: PASS when no step reads FAIL, an INCONCLUSIVE step alone included, since INCONCLUSIVE reads this Mac, not the build.
export const gateLine = (sha: string, failed: boolean): string =>
  `New-user gate at ${sha}: ${failed ? "FAIL" : "PASS"}`

// The line a ship whose gate the owner chose to skip holds in place of the gate's FAIL line: ship:merge reads the Inbox decision it names.
export const waiverLine = (sha: string, id: string): string =>
  `New-user gate at ${sha}: waived by Inbox ${id}`

// The one row label a waiver's decision offers and the owner approves, word for word: words read by a pattern let a negation ("Do not skip ...") through.
export const WAIVER_LABEL = "Ship everything now, skip the new-user check this once"

// The results a rehearsal line may hold for ship:merge to go on: it passed, or the candidate changes no update path, so none was needed.
export const REHEARSAL_RESULTS = ["PASS", "not needed"]

export const rehearsalLine = (sha: string, result: string): string =>
  `Invitee rehearsal at ${sha}: ${result}`

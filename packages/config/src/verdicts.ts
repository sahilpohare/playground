// The verdicts a Playground PR's gates and the Dashboard read, in one module both import, so a format change or a stricter reading cannot leave one reader behind. Every verdict comment is posted as the repo's owner. Three kinds, each a comment's first line: the reviewer's score, which pr:merge gates on, the tester's word on its drive, which pr:merge gates a web/next diff on and the Dashboard shows, and the new-user gate's word, which pr:merge gates an installer or first-run diff on.

export type GateName = "new-user" | "review" | "tester"

// round and score: a review's.
export type Verdict = {
  at: string
  createdAt?: string
  gate: GateName
  pass: boolean
  round?: number
  score?: number
  text: string
  url?: string
}

// ## ReviewBot · round 2: 5/5 at 69a6a4c · 0 blocking, ...
const REVIEW = /^##\s*ReviewBot\s*·\s*round\s+(\d+):\s*(\d)\/5\s+at\s+([0-9a-f]{7,40})/i

// ## TesterBot · PASS at 69a6a4c · ...
const TESTER = /^##\s*TesterBot\s*·\s*(PASS|FAIL)\s+at\s+([0-9a-f]{7,40})/i

// ## NewUserGate · INCONCLUSIVE at 69a6a4c · 6 of 7 passed, 1 inconclusive; 7. Usage: ...
const NEW_USER = /^##\s*NewUserGate\s*·\s*(PASS|FAIL|INCONCLUSIVE)\s+at\s+([0-9a-f]{7,40})/i

// Pure: the verdict a comment's first line carries, a review, a tester's word or the new-user gate's, null for any other comment.
export function verdictOf(body: string): Verdict | null {
  const line = body.trimStart().split("\n")[0]?.trim() ?? ""
  const review = REVIEW.exec(line)
  if (review) {
    const [, round, score, at = ""] = review
    return {
      at: at.toLowerCase(),
      gate: "review",
      pass: score === "5",
      round: Number(round),
      score: Number(score),
      text: line,
    }
  }
  const newUser = NEW_USER.exec(line)
  if (newUser) {
    const [, word = "", at = ""] = newUser
    return {
      at: at.toLowerCase(),
      gate: "new-user",
      pass: word.toUpperCase() === "PASS",
      text: line,
    }
  }
  const tester = TESTER.exec(line)
  if (tester) {
    const [, word = "", at = ""] = tester
    return { at: at.toLowerCase(), gate: "tester", pass: word.toUpperCase() === "PASS", text: line }
  }
  return null
}

// Pure: the verdicts a comment carries, none or one.
export const verdictsOf = (body: string): Verdict[] => {
  const verdict = verdictOf(body)
  return verdict ? [verdict] : []
}

// A verdict's sha names the head when it is a prefix of it (a sha7 or the whole sha).
export const atHead = (at: string, head: string): boolean =>
  at.length >= 7 && head.toLowerCase().startsWith(at.toLowerCase())

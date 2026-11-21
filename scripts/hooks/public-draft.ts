// The public-draft check, which `bun run ask new` and `edit` run on a draft with no link, a public post's (publicDraftRefusal in api/hono/src/lib/dashboard/public-draft.ts): `bun --no-env-file scripts/hooks/public-draft.ts <text>` exits 2 printing the refusal while the text holds a work figure (a count beside PR, pull request, commit or session) or an internal name, which the public rule keeps out of a public post, and 0 when it holds neither. The names come from the two leak guards' own finders (no-playground-leak's terms, roster and skills, and no-public-leak's kinds), so each name has one list; a ticket or PR number and the settings' repositories are this check's own. The refusal names the kind of text and its fix, never the text, and a list that cannot be read refuses as the guards do.
import "../../packages/env/src/aliases"
import { dataDir } from "../../packages/env/src/data-dir"
import {
  EMPTY_LIST,
  isPublicList,
  type Kind,
  patterns,
  reposOf,
} from "../../packages/scripts/src/trace-count/kinds"
import { readPolicy } from "../../packages/settings/src/rendered"
import { guardList } from "./lists"
import { factoryTerms, type Hit, REPHRASE } from "./no-playground-leak"
import { SAID } from "./no-public-leak"

type Environment = Record<string, string | undefined>
export type Checked =
  | { hit: Hit; refusal?: undefined }
  | { hit?: undefined; refusal: string }
  | { hit?: undefined; refusal?: undefined }

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

// A count: digits (1,204, 1.2k, 40+), a dozen, a hundred or a thousand, or a number word from two up, so "one commit reverts it", how the owner talks, stays.
const ONES = "two|three|four|five|six|seven|eight|nine"
const TEENS = "ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen"
const TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety"
const COUNT = `\\d+(?:,\\d{3})*(?:\\.\\d+)?k?\\+?|(?:a |several )?(?:dozens?|hundreds?|thousands?)(?: of)?|(?:${TENS})(?:-(?:one|${ONES}))?|${TEENS}|${ONES}`
// A work figure: a count beside PR, pull request, commit or session, one word between them at most ("12 merged PRs"), past a number that ends a fraction or a span ("24/7 sessions").
export const FIGURE = new RegExp(
  `(?<![\\w#./-])(?:${COUNT})\\s+(?:[a-z]+\\s+)?(?:PRs?|pull[ -]requests?|commits?|sessions?)(?![\\w-])`,
  "i",
)
const FIGURE_HIT: Hit = {
  detail: "a work figure (a PR, commit or session count)",
  fix: "Say what shipped or changed, with no count.",
}
const TERM_HIT: Hit = { detail: "a factory term (a tool's or a session's name)", fix: REPHRASE }
// A ticket or PR number, which no-public-leak lets through, since the public repository speaks of its own issues: trace-count's issue refs (#NN) and the factory's own item keys (PG-<n>, AGENTS.md).
const TICKET_KINDS = new Set<Kind>(["issueRefs"])
const ITEM_KEY = /(?<![\w-])PG-\d+(?![\w-])/i
const TICKET_HIT: Hit = {
  detail: "a ticket or PR number",
  fix: "Say what changed in plain words, with no number.",
}
const REPO_HIT: Hit = {
  detail: "a repository's name",
  fix: "Say what the work is, not which repository holds it.",
}
// A GitHub repository by its link.
const REPO_LINK = /github\.com\/[\w.-]+\/[\w.-]+/i

// What `bun run ask` says of a hit: the kind of text and its fix, never the text, and the fix for a colleague's draft that lacks its link.
export const publicRefusal = (hit: Hit): string =>
  `a draft with no link is a public post's, which holds the owner's own words alone (playground rules public), and this one holds ${hit.detail}. ${hit.fix} A draft to a colleague carries its Slack or Linear link instead, and this check leaves that one alone.`

// The first internal figure or name in a public post's text, in the order a refusal names them: a work figure, a factory term, a kind no-public-leak refuses, a ticket or PR number, a repository; or the refusal of a list that cannot be read, so the check fails closed as the guards do.
export async function publicDraftHit(
  text: string,
  environment: Environment = process.env,
  checkout?: string,
  lists?: string,
): Promise<Checked> {
  if (FIGURE.test(text)) return { hit: FIGURE_HIT }
  const terms = await factoryTerms(environment, checkout, lists)
  if (terms.refusal !== undefined) return { refusal: terms.refusal }
  if (terms.pattern.test(text)) return { hit: TERM_HIT }
  const list = await guardList(
    "no-public-leak",
    "no-public-leak",
    isPublicList,
    EMPTY_LIST,
    environment,
  )
  if (list.refusal !== undefined) return { refusal: list.refusal }
  const read = await readPolicy(dataDir(environment))
  if (read.refusal !== undefined)
    return {
      refusal: `the public-draft check cannot read the extensions' settings (${read.refusal}), so it cannot name the repositories; fix that, then post again.`,
    }
  const repos = reposOf(read.settings, checkout)
  for (const [kind, re] of patterns(list.list, repos)) {
    if (text.search(re) === -1) continue
    const said = SAID[kind] ?? (TICKET_KINDS.has(kind) ? TICKET_HIT : undefined)
    if (said) return { hit: said }
  }
  if (ITEM_KEY.test(text)) return { hit: TICKET_HIT }
  const named = [...repos.public, repos.archive]
    .filter((repo) => repo !== "")
    .map((repo) => new RegExp(`(?<![\\w.-])${escape(repo)}(?![\\w-])`, "i"))
  if (named.some((re) => re.test(text)) || REPO_LINK.test(text)) return { hit: REPO_HIT }
  return {}
}

if (import.meta.main) {
  const [text, ...extra] = process.argv.slice(2)
  if (text === undefined || extra.length > 0) {
    console.error("usage: bun --no-env-file scripts/hooks/public-draft.ts <text>")
    process.exit(1)
  }
  const checked = await publicDraftHit(text)
  const reason = checked.refusal ?? (checked.hit ? publicRefusal(checked.hit) : undefined)
  if (reason !== undefined) {
    console.error(reason)
    process.exit(2)
  }
}

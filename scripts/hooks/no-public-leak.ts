// PreToolUse hook for the factory's sessions (role.ts), registered in both settings files: refuses a write to a public repository (a pull request, an issue, a review or a comment, through gh, gh api, curl or the GitHub MCP) whose text holds a name, a handle, a company term, a Slack id or a Linear key from its list, or an email address (but one on example.com, example.org or example.net, which RFC 2606 keeps for examples) or an archive link, since everything written there is public once the repository is. Its reason names the kind of text, never the text; it reads every write as no-playground-leak does, through that guard's engine, and each kind as the trace ratchet counts it (packages/scripts/src/trace-count/kinds.ts).
import "../../packages/env/src/aliases"
import { dataDir } from "../../packages/env/src/data-dir"
import { CONTRIBUTORS_HEADING, ownerWords } from "../../packages/scripts/src/release-notes/notes"
import {
  EMPTY_LIST,
  isPublicList,
  type Kind,
  LIST_KEYS,
  type PublicList,
  patterns,
  readPast,
  type Repos,
  reposOf,
} from "../../packages/scripts/src/trace-count/kinds"
import { ownerSettings } from "../../packages/settings/src/owner"
import { readPolicy } from "../../packages/settings/src/rendered"
import { input } from "./input"
import { guardList } from "./lists"
import { type Hit, inspectAs, type Policy, refusedList } from "./no-playground-leak"
import { fromFactory } from "./role"

type Environment = Record<string, string | undefined>

const PERSON = "Say the role (the owner, a reviewer, a worker) in place of the person."

// What a refusal says of each kind it refuses, and its plain-words fix, which the public-draft check (public-draft.ts) says too; #NNN and the old session names are the public repository's own words, so a write may hold them.
export const SAID: Partial<Record<Kind, Hit>> = {
  archiveLinks: {
    detail: "an archive link",
    fix: "Describe what it points to, or link this repository's own copy.",
  },
  companies: { detail: "a company term", fix: "Name the work in plain words, not whose it is." },
  emails: { detail: "an email address", fix: "Leave the address out." },
  handles: { detail: "a handle", fix: PERSON },
  linearKeys: { detail: "a Linear key", fix: "Describe the ticket in plain words." },
  names: { detail: "a person's name", fix: PERSON },
  slackIds: {
    detail: "a Slack id",
    fix: "Leave the id out, and say what the conversation settled.",
  },
}

// A plain ship notes write, one `gh release create` or `edit` with no substitution, chain, pipe or redirect, the one call whose notes may name the owner.
const SHIP = /^\s*gh release (?:create|edit)\b[^`$();&|<>\n]*$/
// A line the renderer's Contributors section holds: `- <names> @<login>` or the login alone.
const CONTRIBUTOR = /^- ((?:\S+ )*)@([\w-]+)\s*$/
// The notes with the owner's own Contributors line read past: the section opens at the renderer's heading and stays open while each line is blank or a contributor's, and a line there whose login and every name owner.names lists is read past, so the same names anywhere else are still refused.
function ownLinesPast(text: string, owner: string[]): string {
  let contributors = false
  return text
    .split("\n")
    .map((line) => {
      if (line.replace(/\r$/, "") === CONTRIBUTORS_HEADING) {
        contributors = true
        return line
      }
      const m = CONTRIBUTOR.exec(line)
      if (!m && line.trim() !== "") contributors = false
      const names = m?.[1].trim() ?? ""
      const login = m?.[2] ?? ""
      const mine =
        contributors &&
        owner.some((word) => word.toLowerCase() === login.toLowerCase()) &&
        ownerWords(names, login, owner).join(" ") === names.split(/\s+/).filter(Boolean).join(" ")
      return mine ? "" : line
    })
    .join("\n")
}

// RFC 2606's example domains, exactly or as a subdomain's end: an address there names no one, so a test's made-up address may go in a public write.
const EXAMPLE_ADDRESS = /@(?:[a-z\d-]+\.)*example\.(?:com|net|org)$/i

// Whether the text holds the kind, every address on an example domain read past.
const holds = (kind: Kind, re: RegExp, text: string): boolean =>
  kind === "emails"
    ? (text.match(re) ?? []).some((hit) => !EXAMPLE_ADDRESS.test(hit))
    : text.search(re) !== -1

// owner: owner.names alone, given only for a plain ship write, since the archive's owner is no name the owner goes by.
function finder(
  list: PublicList,
  repos: Repos,
  owner?: string[],
): (text: string) => Hit | undefined {
  const kinds = patterns(list, repos).filter(([kind]) => SAID[kind])
  return (text) => {
    const said = readPast(owner ? ownLinesPast(text, owner) : text, repos)
    const found = kinds.find(([kind, re]) => holds(kind, re, said))
    return found && SAID[found[0]]
  }
}

const policy = (list: PublicList, repos: Repos, owner?: string[]): Policy => ({
  find: finder(list, repos, owner),
  git: false,
  guard: "no-public-leak",
  guarded: (repo) => repos.public.includes(`${repo.owner}/${repo.repo}`.toLowerCase()),
  hosts: false,
  place: "a public repository",
  what: "private text",
  why: `Everything written to ${repos.public.join(" or ")} is public once the repository is, and stays cached after, so it names no person, company or private record.`,
})

const shipWrite = (raw: string): boolean => {
  try {
    const { tool_input: input, tool_name: tool } = JSON.parse(raw) as {
      tool_input?: { command?: unknown }
      tool_name?: unknown
    }
    return tool === "Bash" && typeof input?.command === "string" && SHIP.test(input.command)
  } catch {
    return false
  }
}

// Fails closed on its list, which only the store holds (lists.ts), and on a store it cannot read for the repositories (factory.publicRepo and factory.archiveRepo, else the checkout's origin), and, as no-playground-leak, only on a call that may write.
export async function check(
  raw: string,
  environment: Environment = process.env,
  checkout?: string,
): Promise<string | undefined> {
  const loaded = await guardList(
    "no-public-leak",
    "no-public-leak",
    isPublicList,
    EMPTY_LIST,
    environment,
  )
  if (loaded.refusal)
    return refusedList(
      raw,
      `${loaded.refusal} The list is a JSON object with an array of strings under each of ${LIST_KEYS.join(", ")}.`,
    )
  const read = await readPolicy(dataDir(environment))
  if (read.refusal !== undefined)
    return refusedList(
      raw,
      `no-public-leak hook refused this call: ${read.refusal}, then run the call again.`,
    )
  return inspectAs(
    policy(
      loaded.list ?? EMPTY_LIST,
      reposOf(read.settings, checkout),
      shipWrite(raw) ? ownerSettings.get(read.settings, "owner.names") : undefined,
    ),
    raw,
    environment,
  )
}

if (import.meta.main) {
  const raw = await input("no-public-leak", "guard")
  const reason = (await fromFactory(raw)) ? await check(raw) : undefined
  if (reason) {
    console.error(reason)
    process.exit(2)
  }
}

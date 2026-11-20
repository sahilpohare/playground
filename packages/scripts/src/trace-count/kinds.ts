// The kinds of private trace, one source for no-public-leak, which refuses a public write holding one, and the trace ratchet, which counts them over the tree: each kind is a pattern, its list-fed kinds read from the list the extensions derive for no-public-leak, never a file in the tree, since that list holds the very text it keeps out.
import { join } from "node:path"

import { factorySettings, ownerSettings, type Settings } from "@packages/settings"

import { dataDir } from "../../../env/src/data-dir"
import { originRepo } from "../playground/setting"

type Environment = Record<string, string | undefined>

// The repositories, and the owner's names (owner.names, then the archive's owner), read from the settings at run time so no private name is written in the tree; an unset archive is empty, which leaves its links unmeasured, and an unset public repository is the origin of the checkout this code runs from (a bundled guard the main checkout), none with no origin.
export type Repos = { archive: string; owner: string[]; public: string[] }
export const reposOf = (settings: Settings, checkout?: string): Repos => {
  const archive = factorySettings.get(settings, "factory.archiveRepo").toLowerCase()
  const archiveOwner = archive ? [archive.split("/")[0]!] : []
  const set = [factorySettings.get(settings, "factory.publicRepo")].flat().filter(Boolean)
  return {
    archive,
    owner: [...new Set([...ownerSettings.get(settings, "owner.names"), ...archiveOwner])],
    public: set.length
      ? set.map((repo) => repo.toLowerCase())
      : [originRepo(checkout)].filter(Boolean),
  }
}
// The repositories with neither key set, as a machine with no store reads them.
export const UNSET_REPOS: Repos = reposOf({ schemaVersion: 1, values: {} })

export type PublicList = {
  companies: string[]
  handles: string[]
  linearKeys: string[]
  names: string[]
  slackIds: string[]
}
export const LIST_KEYS = ["companies", "handles", "linearKeys", "names", "slackIds"] as const
export const EMPTY_LIST: PublicList = {
  companies: [],
  handles: [],
  linearKeys: [],
  names: [],
  slackIds: [],
}
export const isPublicList = (value: unknown): value is PublicList =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  LIST_KEYS.every((key) => {
    const items = (value as Record<string, unknown>)[key]
    return Array.isArray(items) && items.every((item) => typeof item === "string")
  })

export const publicListPath = (environment: Environment = process.env): string =>
  join(dataDir(environment), "extensions", "hooks", "no-public-leak.json")

export type Kind =
  | "archiveLinks"
  | "companies"
  | "companyName"
  | "emails"
  | "handles"
  | "issueRefs"
  | "lightWords"
  | "linearKeys"
  | "names"
  | "oldNames"
  | "oldSkillNames"
  | "ownerName"
  | "slackIds"

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
// A list's entries, each standing alone as the leak guard's terms do; none when the list is empty.
export const anyOf = (items: string[], tail = ""): RegExp | undefined =>
  items.length
    ? new RegExp(`(?<![a-z\\d])(?:${items.map(escape).join("|")})${tail}(?![a-z\\d])`, "gi")
    : undefined

// A name in either case, standing alone, never inside an address, and never followed by a slash and a path word, which reads as data (a repository URL, a slug such as the archive's own link, which archiveLinks counts, or any path).
export const ownerWord = (name: string): string => {
  const cased = [...name].map((c) =>
    /[a-z]/i.test(c) ? `[${c.toLowerCase()}${c.toUpperCase()}]` : escape(c),
  )
  return `(?<![a-zA-Z\\d])(?<![\\w.+-]@[\\w.-]*)${cased.join("")}(?![a-zA-Z\\d])(?!/[\\w-])(?![\\w.+-]*@)`
}
// The owner's names, a quote set against the owner (`the owner, 24 Oct: "`, `the owner said`), or anyone's dated quote (`Corin, 23 Oct: "`), so the repo's text names no person and quotes no one; none with no names to read, as a list kind has none with an empty list. Case is spelled out, since a dated quote's name is read by its capital.
const ownerName = (repos: Repos): RegExp | undefined => {
  if (!repos.owner.length) return undefined
  const MONTH = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*"
  return new RegExp(
    [
      ...repos.owner.map(ownerWord),
      `\\b[Tt]he owner(?:,[^:"\\n]{0,40})?:\\s*["“]`,
      "\\b[Tt]he owner (?:said|wrote)\\b",
      `\\b[A-Z][a-z]+, \\d{1,2} ${MONTH}\\b[^"\\n]{0,30}: *["“]`,
    ].join("|"),
    "g",
  )
}
const LIGHT_SUFFIXES = "man|kid|boy|plan|review|board|day|ask|check|db|pass|emplates|setup"

// Each kind's pattern, global so the ratchet can count it, in the order a refusal names the first that matches; a kind with an empty list has none.
export function patterns(list: PublicList, repos: Repos): [Kind, RegExp][] {
  const all: [Kind, RegExp | undefined][] = [
    [
      "archiveLinks",
      repos.archive
        ? new RegExp(`(?<![\\w.-])${escape(repos.archive)}(?![\\w.-])`, "gi")
        : undefined,
    ],
    ["emails", /[a-z\d._%+-]+@[a-z\d-]+(?:\.[a-z\d-]+)*\.[a-z]{2,}/gi],
    ["names", anyOf(list.names)],
    ["handles", anyOf(list.handles)],
    ["companies", anyOf(list.companies)],
    ["slackIds", anyOf(list.slackIds)],
    ["linearKeys", anyOf(list.linearKeys, "-\\d+")],
    ["issueRefs", /(?<![\w&/])#[1-9]\d+(?![\w-])/g],
    ["oldNames", /(?<![a-z\d])(?:lightboy|lightkid|lightman|lightplan)(?![a-z\d])/gi],
    [
      "oldSkillNames",
      /(?<![a-z\d])(?:lightask|lightboard|lightcheck|lightday|lightdb|lightemplates|lightpass|lightreview|lightsetup)(?![a-z\d])/gi,
    ],
    ["ownerName", ownerName(repos)],
    ["companyName", /(?<![a-z\d])(?:light[ -]?work|newgen)(?![a-z\d])/gi],
    // A factory or old skill word glued into a longer one (fromX, Xs, XMusic), which the two kinds above read past, and a skill they never named; a UI light (highlight, lightfacts) holds no such word.
    [
      "lightWords",
      new RegExp(
        `(?<![a-z\\d])light(?:${LIGHT_SUFFIXES})[a-z\\d]+|(?<=[a-z\\d])light(?:${LIGHT_SUFFIXES}|quill)|(?<![a-z\\d])lightquill`,
        "gi",
      ),
    ],
  ]
  return all.filter((kind): kind is [Kind, RegExp] => kind[1] !== undefined)
}

// A public repository's own name holds its owner's handle and names nothing private, so it is read past.
export const readPast = (text: string, repos: Repos): string =>
  text.replace(
    new RegExp(`(?<![\\w.-])(?:${repos.public.map(escape).join("|")})(?![\\w.-])`, "gi"),
    "",
  )

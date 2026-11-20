// playground update's brief refresh: a manager's brief copy in the data folder follows its template while unedited, and an edited one stays, its manager sent the template's diff.
import { appendFile, rename } from "node:fs/promises"
import { join } from "node:path"

import { writeAtomic } from "../write-atomic"

export type Send = (to: string, text: string) => Promise<boolean>

// The diff an update holds for a manager until it is sent, and where the sent one stays for the manager to read, since an outbox line stops at 400 characters.
const pendingOf = (data: string, name: string) => join(data, `brief-${name}.diff`)
const sentOf = (data: string, name: string) => join(data, `brief-${name}.sent.diff`)

const git = async (repo: string, ...args: string[]): Promise<string> => {
  const proc = Bun.spawn(["git", "-C", repo, ...args], { stderr: "pipe", stdout: "pipe" })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (code !== 0) throw new Error(`git ${args[0]}: ${err.trim().slice(0, 200)}`)
  return out
}

// The newest commit in HEAD's or old's history whose template is this copy byte for byte, by its blob id, so a copy written from any committed version reads as unedited, one from past HEAD too when --to moved back; none when it is not one.
const writtenFrom = async (repo: string, template: string, copy: string, old: string) => {
  const blob = (await git(repo, "hash-object", copy)).trim()
  let commit = ""
  for (const line of (
    await git(repo, "log", "--format=%H", "--raw", "--no-abbrev", "HEAD", old, "--", template)
  ).split("\n")) {
    if (/^[0-9a-f]{40}$/.test(line)) commit = line
    else if (line.startsWith(":") && line.split(/\s+/)[3] === blob) return commit
  }
  return undefined
}

// Queues one line naming a manager's held diff, then moves it to its sent file, so a send that throws leaves it held; false when none is held.
export const tellPending = async (data: string, name: string, send: Send): Promise<boolean> => {
  const pending = pendingOf(data, name)
  if (!(await Bun.file(pending).exists())) return false
  const sent = sentOf(data, name)
  await send(
    name,
    `your brief's template changed since you started: its diff is in ${sent}, each part headed by whether brief-${name}.md followed it or kept its edits; read it and take what applies to you now.`,
  )
  await rename(pending, sent)
  return true
}

export const refreshBriefs = async (o: {
  data: string
  live: (name: string) => boolean
  log: (line: string) => void
  managers: { kind: string; name: string }[]
  old: string
  repo: string
  send: Send
}): Promise<void> => {
  // one manager's failure is logged and the rest still run
  const refresh = async ({ kind, name }: { kind: string; name: string }) => {
    const copy = join(o.data, `brief-${name}.md`)
    if (!(await Bun.file(copy).exists())) return
    const template = `scripts/briefs/${kind}.md`
    const text = await git(o.repo, "show", `HEAD:${template}`)
    if ((await Bun.file(copy).text()) === text) return
    const from = await writtenFrom(o.repo, template, copy, o.old)
    const diff = await git(o.repo, "diff", from ?? o.old, "HEAD", "--", template)
    if (from) {
      await writeAtomic(copy, text)
      o.log(`playground update: brief-${name}.md followed ${template}`)
    }
    if (!diff) return
    if (!from) o.log(`playground update: brief-${name}.md holds edits, so it stays`)
    const head = from ? "followed this change" : "kept its edits; this change is not in it"
    await appendFile(pendingOf(o.data, name), `# brief-${name}.md ${head}\n${diff}`, {
      mode: 0o600,
    })
    if (o.live(name)) await tellPending(o.data, name, o.send)
  }
  for (const manager of o.managers)
    await refresh(manager).catch((error: Error) =>
      o.log(`playground update: brief-${manager.name}.md: ${error.message}`),
    )
}

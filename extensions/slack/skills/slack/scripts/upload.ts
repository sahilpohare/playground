import { join } from "node:path"

import { REPO } from "../../../../../packages/scripts/src/ops-job/job"
import { check as publicLeak } from "../../../../../scripts/hooks/no-public-leak"
import { leakOf } from "./send"
import { call, type Member, type Slack, slackOf, tokenOf } from "./slack"

// The byte post to the URL Slack hands back, which takes no token.
export type Put = (
  url: string,
  bytes: Uint8Array<ArrayBuffer>,
) => Promise<{ ok: boolean; status: number }>

// A file to share: the name it shows in Slack, its bytes, and whether those bytes are text, so its words are guarded as a post's.
export type UploadFile = { bytes: Uint8Array<ArrayBuffer>; name: string; text: boolean }

export const putOf = (): Put => async (url, bytes) => {
  const res = await fetch(url, {
    body: new Blob([bytes]),
    method: "POST",
    signal: AbortSignal.timeout(60_000),
  })
  return { ok: res.ok, status: res.status }
}

// Slack's three external-upload steps: an upload URL for each file, its bytes posted there, then one complete that shares them all into the channel, in the thread when one is named, with the words as their message when given. Any step Slack refuses throws, and a file whose bytes did not land shares nothing.
export async function upload({
  channel,
  files,
  put,
  slack,
  text,
  thread,
}: {
  channel: string
  files: UploadFile[]
  put: Put
  slack: Slack
  text?: string
  thread?: string
}): Promise<number> {
  const shared: { id: string; title: string }[] = []
  for (const file of files) {
    const reply = await call(slack, "files.getUploadURLExternal", {
      filename: file.name,
      length: String(file.bytes.length),
    })
    const posted = await put(reply.upload_url!, file.bytes)
    if (!posted.ok)
      throw new Error(`the bytes of ${file.name} did not upload: HTTP ${posted.status}`)
    shared.push({ id: reply.file_id!, title: file.name })
  }
  await call(slack, "files.completeUploadExternal", {
    channel_id: channel,
    files: JSON.stringify(shared),
    ...(text ? { initial_comment: text } : {}),
    ...(thread ? { thread_ts: thread } : {}),
  })
  return files.length
}

// What the words hold, read left to right: a fenced block, a code span or a Slack token already written (`<...>`), each kept as written; a URL, its closing punctuation left out; or a mention as the Inbox reads one: an @ outside a word or an email, then the name.
const PIECES =
  /(```[\s\S]*?```|`[^`\n]*`|<[^<>\s][^<>]*>)|(https?:\/\/[^\s<>|`]*[^\s<>|`.,;:!?)\]}'"*_~])|(?<![\p{L}\p{N}_.])@([\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?)/giu

// Every member of the workspace, a page of users.list at a time.
async function members(slack: Slack): Promise<Member[]> {
  const all: Member[] = []
  let cursor = ""
  do {
    const reply = await call(slack, "users.list", { limit: "200", ...(cursor && { cursor }) })
    all.push(...(reply.members ?? []))
    cursor = reply.response_metadata?.next_cursor ?? ""
  } while (cursor)
  return all
}

// The words as the files' message carries them, as the poster would post them: each @name as the token of the one member whose username, display name or real name it is, and each URL as a link labelled without its scheme, as a link chip shows it; a name that matches no member or more than one throws, naming it.
async function slackWords(slack: Slack, words: string): Promise<string> {
  const names = [...words.matchAll(PIECES)].flatMap((piece) => (piece[3] ? [piece[3]] : []))
  const ids = new Map<string, string>()
  const all = names.length ? (await members(slack)).filter((member) => !member.deleted) : []
  for (const name of names) {
    const key = name.toLowerCase()
    const found = all.filter((member) =>
      [member.name, member.profile?.display_name, member.profile?.real_name].some(
        (known) => known?.toLowerCase() === key,
      ),
    )
    if (found.length !== 1)
      throw new Error(
        `@${name} matches ${found.length ? `${found.length} Slack users` : "no Slack user: only a person can be tagged"}`,
      )
    ids.set(key, found[0]!.id)
  }
  return words.replace(PIECES, (kept: string, written?: string, url?: string, name?: string) =>
    written
      ? kept
      : url
        ? `<${url}|${url.replace(/^https?:\/\//i, "")}>`
        : `<@${ids.get(name!.toLowerCase())}>`,
  )
}

export type Check = (raw: string) => Promise<string | undefined>

// The words a file carries into the channel: its name, and a text file's words too.
export const wordsOf = (file: UploadFile): string =>
  file.text ? `${file.name}\n${new TextDecoder().decode(file.bytes)}` : file.name

// The guards dm send runs on a post (no-playground-leak), and no-public-leak, on words as one post to the channel would carry them.
export async function guarded(
  channel: string,
  text: string,
  checks: { playground: (text: string) => Promise<string | undefined>; public: Check } = {
    playground: leakOf(channel),
    public: publicLeak,
  },
): Promise<string | undefined> {
  const raw = JSON.stringify({
    tool_input: { channel, text },
    tool_name: "mcp__slack-shared__chat_post_message",
  })
  return (await checks.playground(text)) ?? (await checks.public(raw))
}

// What the API's dashboard-upload.ts prints for one answered item: the place, the files and a draft's words, read from the item itself.
export type Spec = {
  channel: string
  files: { bytes: string; name: string; text: boolean }[]
  text?: string
  thread?: string
}

// The spec of one item, read by this checkout's dashboard-upload.ts from its own database, in a process that never holds the token.
export const specOf = async (id: string): Promise<Spec> => {
  const child = Bun.spawn(["bun", join(REPO, "api/hono/src/bin/dashboard-upload.ts"), id], {
    cwd: REPO,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(err.trim().split("\n").at(-1) || `dashboard-upload exit ${code}`)
  return JSON.parse(out) as Spec
}

// Shares one answered Inbox item's files, with a draft's words as their message (slackWords), named by its id alone: the place, the files and the words come from the item, each is guarded and each mention resolved before any file is shared, and a refused one shares nothing.
export async function share(
  id: string,
  {
    check = guarded,
    put,
    read = specOf,
    slack,
  }: { check?: typeof guarded; put: Put; read?: (id: string) => Promise<Spec>; slack: Slack },
): Promise<number> {
  const spec = await read(id)
  const files = spec.files.map((file) => ({
    bytes: Uint8Array.from(Buffer.from(file.bytes, "base64")),
    name: file.name,
    text: file.text,
  }))
  for (const file of files) {
    const refusal = await check(spec.channel, wordsOf(file))
    if (refusal) throw new Error(`${file.name}: ${refusal}`)
  }
  const refusal = spec.text && (await check(spec.channel, spec.text))
  if (refusal) throw new Error(`the message: ${refusal}`)
  const text = spec.text && (await slackWords(slack, spec.text))
  return upload({ channel: spec.channel, files, put, slack, text, thread: spec.thread })
}

// its errors as one plain line, which the dashboard shows as the send's reason
if (import.meta.main) {
  const [id, ...extra] = process.argv.slice(2)
  try {
    if (!id || extra.length)
      throw new Error("usage: upload.ts <inbox item id>, run by playground dm upload")
    const count = await share(id, { put: putOf(), slack: slackOf(await tokenOf()) })
    console.log(`dm upload: shared ${count} files`)
  } catch (error) {
    console.error(`error: ${(error as Error).message}`)
    process.exit(1)
  }
}

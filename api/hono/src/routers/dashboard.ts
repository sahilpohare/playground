import { sValidator } from "@hono/standard-validator"
import type { Session } from "@packages/auth"
import { SESSION_EFFORTS, SESSION_MODELS } from "@packages/config/console"
import {
  threadIdSchema,
  threadPatchSchema,
  THREADS_PER_PAGE,
  threadSchema,
  threadsPageSchema,
  withMarker,
} from "@packages/config/threads"
import { db } from "@packages/db"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { bodyLimit } from "hono/body-limit"
import type { ContentfulStatusCode } from "hono/utils/http-status"
import { z } from "zod"

import { parseWatchMessage } from "@/lib/dashboard/activity"
import { agentsBoard } from "@/lib/dashboard/agents"
import {
  ATTACHED_LABEL,
  contentType,
  findAttachment,
  ID_PATTERN,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  readAttachment,
  storeAttachment,
  TOO_LARGE_REASON,
  type Attachment,
  type StoreRefusal,
  type Stored,
} from "@/lib/dashboard/attachments"
import {
  COMMAND_START,
  deliver,
  FAILURE_STATUS,
  MAX_CHARS,
  normalize,
  sessionSkills,
  type Delivery,
  type DeliveryResult,
} from "@/lib/dashboard/deliver"
import {
  answerFeed,
  PERMISSION_MODES,
  PLAN_MODES,
  TEXT_LIMIT,
  type FeedAnswering,
  type FeedFailure,
  type FeedResult,
} from "@/lib/dashboard/feed"
import { boardFrame, dashboardHub } from "@/lib/dashboard/hub"
import { recordReply as recordReplyItem, REPLY_RE } from "@/lib/dashboard/inbox"
import {
  clearManagersOrder,
  managersOrderSchema,
  unknownManager,
  writeManagersOrder,
} from "@/lib/dashboard/managers-order"
import { readOps } from "@/lib/dashboard/ops"
import {
  PASTE_REPORT_BYTES,
  PASTE_REPORT_ENTRIES,
  PASTE_REPORTS_KEPT,
  pasteReportSchema,
  storePasteReport,
} from "@/lib/dashboard/paste-report"
import { restartPrs, restartSession } from "@/lib/dashboard/restart"
import { readRoster } from "@/lib/dashboard/roster"
import {
  answerHosted,
  changeHostedMode,
  changeHostedSetting,
  HOSTED_MODES,
  hosts,
  SDK_PROBE,
  sendToHosted,
  type ModeChanging,
  type ModeResult,
  type SettingChanging,
} from "@/lib/dashboard/sdk"
import { settingRequestSchema, type SessionSetting } from "@/lib/dashboard/setting"
import { readStacks } from "@/lib/dashboard/stacks"
import {
  createThread,
  dropThread,
  listThreads,
  patchThread,
  threadExists,
  threadMessages,
} from "@/lib/dashboard/threads"
import { AGENT_ID_PATTERN, readTail, subagentPath } from "@/lib/dashboard/transcript"
import { startVibe, stopVibe, VibeError } from "@/lib/dashboard/vibe"
import {
  assistantSeat,
  DISPATCHER,
  DISPATCHERS,
  kindOf,
  listLive,
  type Live,
} from "@/lib/dashboard/workers"
import { searchYouTube } from "@/lib/dashboard/youtube-search"
import { attachmentDisposition } from "@/lib/download"
import {
  ApiError,
  authErrorResponses,
  errorResponse,
  forbiddenErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
  type ErrorCode,
} from "@/lib/error"
import { upgradeWebSocket } from "@/lib/server"
import { listAccounts } from "@/lib/store/accounts"
import { systemReport } from "@/lib/system/sampler"
import {
  authMiddleware,
  createRateLimiter,
  guardWrites,
  requireConsoleRole,
  requireTrustedOrigin,
} from "@/middlewares"

// A person types a handful of messages a minute; this stops a stuck client or a loop from flooding a session's input.
export const messageLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 20,
  windowMs: 60_000,
})

// A person answers a prompt or two a minute; this stops a stuck client from replaying answers into a session's pane.
export const answerLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 20,
  windowMs: 60_000,
})

// A person flips a session's mode a few times at most; each one changes what the session may do unasked.
export const modeLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 10,
  windowMs: 60_000,
})

// A person sets a model or an effort a few times at most; each one changes a running session.
export const settingLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 10,
  windowMs: 60_000,
})

// A restart closes and reopens a session's pane; a person asks for one after adding an account, so a few a minute is plenty.
export const restartLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 5,
  windowMs: 60_000,
})

// A Vibeground's Start seeds a database and starts a stack, its Stop ends one; a person clicks a few a minute at most.
export const vibeLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 6,
  windowMs: 60_000,
})

const vibeSchema = z.object({ path: z.string().min(1).max(4096) })

// A drag writes the whole order; a run of quick drags stays well under this, which only stops a stuck client.
export const managersOrderLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 30,
  windowMs: 60_000,
})

// Uploads come one file a request, each checked and kept before the next; a person attaches a few at a time.
export const attachmentLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 30,
  windowMs: 60_000,
})

// TEMPORARY: a dictation that missed the box reports once, a few a minute at most; remove with the paste report.
export const pasteReportLimiter = createRateLimiter({
  getUserId: (c) => c.get("session")?.userId,
  limit: 6,
  windowMs: 60_000,
})

// A page load's 200 entries at their longest real names and types come to about 73 KB; the browser sends only what fits.
export const pasteReportBodyLimit = bodyLimit({
  maxSize: PASTE_REPORT_BYTES,
  onError: () => {
    throw new ApiError(
      413,
      "PAYLOAD_TOO_LARGE",
      `A paste report holds at most ${PASTE_REPORT_BYTES / 1024} KB`,
    )
  },
})

export const pasteReportBody = sValidator("json", pasteReportSchema, (result) => {
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
  }
})

const messageSchema = z.object({
  attachments: z.array(z.string().regex(ID_PATTERN)).max(MAX_ATTACHMENTS).default([]),
  id: z.uuid().optional(),
  newThread: z.boolean().optional(),
  queuedAt: z.iso.datetime().optional(),
  text: z.string().max(MAX_CHARS * 2),
  threadId: threadIdSchema.optional(),
  to: z.string().min(1).max(200),
})

// Pure: a new thread's title, the message's opening as every terminal keeps it: the first line up to a space before a path, where Claude Code splits a paste, at most 80 characters; a message of files alone opens with its Attached label.
export const quoteOf = (text: string, files: number): string => {
  const line = (normalize(text).split("\n")[0] ?? "").split(/ (?=\/|[A-Za-z]:\\)/)[0] ?? ""
  const words = Array.from(line.trimEnd()).slice(0, 80).join("")
  return words || (files ? ATTACHED_LABEL : "")
}

const threadStore = {
  create: (title: string) => createThread(db, title),
  drop: (id: string) => dropThread(db, id),
  exists: (id: string) => threadExists(db, id),
}

// The message route's work once the request is through its guards: phase 2a's boundary (either dispatcher or the session the roster seats as the assistant, typed into its terminal, or the session the dashboard hosts on the Agent SDK, put on its input), then each attachment id found in the attachments folder (one that finds nothing stops the message before anything is sent, naming the id under `attachment` so the composer can drop it), then the delivery, its refusal turned into the API's error envelope with the reason's code under `delivery`. A message naming an inbox item (`re #iN`) records the reply on it once it is out. A message with a threadId, or newThread, which opens a thread titled from its first line, goes to the primary dispatcher alone, to a thread that exists, with the thread's marker put first, which routes it once ingest brings it; a new thread its delivery never reached is dropped, and one a message cut off while typing may have reached is named in the refusal.
export async function sendMessage(
  {
    attachments: ids = [],
    id: messageId,
    newThread,
    queuedAt,
    text,
    threadId: named,
    to,
  }: z.input<typeof messageSchema>,
  actor: Delivery["actor"],
  send: (delivery: Delivery) => Promise<DeliveryResult> = deliver,
  find: (id: string) => Promise<Attachment | null> = findAttachment,
  sendHosted: (delivery: Delivery) => Promise<DeliveryResult> = sendToHosted,
  recordReply: (ref: number, text: string) => Promise<unknown> = (ref, text) =>
    recordReplyItem(db, ref, undefined, text),
  threads: typeof threadStore = threadStore,
  assistant: () => Promise<string | undefined> = assistantSeat,
): Promise<{ at: string; sessionId: string; threadId?: string }> {
  const typed = DISPATCHERS.includes(to) || (to !== SDK_PROBE && to === (await assistant()))
  if (!typed && to !== SDK_PROBE) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `Messages go to ${[...DISPATCHERS, "the assistant", SDK_PROBE].join(", ")} only for now`,
    )
  }
  if (named && newThread) {
    throw new ApiError(400, "VALIDATION_ERROR", "Give threadId or newThread, not both")
  }
  if ((named || newThread) && to !== DISPATCHER) {
    throw new ApiError(400, "VALIDATION_ERROR", `A thread's messages go to ${DISPATCHER} alone`)
  }
  if (named && !(await threads.exists(named))) {
    throw new ApiError(404, "NOT_FOUND", "No thread with that id")
  }
  const attachments: Attachment[] = []
  for (const id of new Set(ids)) {
    const file = await find(id)
    if (!file) {
      throw new ApiError(
        404,
        "NOT_FOUND",
        "An attachment is gone: files are kept for a week after they arrive. Attach it again.",
        { attachment: "GONE", id },
      )
    }
    attachments.push(file)
  }
  // the marker goes before words or files, so an empty message is still refused as one, and never before a / or ! command, which runs as a skill or is refused as typed, so a command goes unmarked and routes nowhere
  const marks = Boolean((normalize(text) || attachments.length) && !COMMAND_START.test(text))
  const opened =
    newThread && marks
      ? await threads.create(quoteOf(text, attachments.length) || "New thread")
      : undefined
  const threadId = marks ? (opened ?? named) : undefined
  const result = await (typed ? send : sendHosted)({
    actor,
    text: threadId ? withMarker(threadId, text) : text,
    to,
    ...(attachments.length && { attachments }),
    ...(messageId && { id: messageId }),
    ...(messageId && queuedAt && { queuedAt }),
  })
  if (!result.ok) {
    // a message cut off while typing may have gone, marker and all, and one left pasted and unsent waits for its retry's Enter, as one Claude Code holds (QUEUED, marked pasted) waits to be read again, so its thread stays and is named, for a retry to send to it
    const held = result.code === "INTERRUPTED" || result.pasted
    const kept = opened && held ? opened : undefined
    if (opened && !kept) await threads.drop(opened)
    const [status, code] = FAILURE_STATUS[result.code]
    throw new ApiError(status, code, result.reason, {
      delivery: result.code,
      ...(result.queuedAt && { queuedAt: result.queuedAt }),
      ...(kept && { threadId: kept }),
    })
  }
  // a retry its first try delivered is answered from its row, the message already in the thread that try opened, so this try's own goes
  const replayed = opened && result.replayed ? opened : undefined
  if (replayed) await threads.drop(replayed)
  const reply = REPLY_RE.exec(text)
  // only the primary dispatcher carries his Inbox, so a quote in the second's, the assistant's or a hosted session's message records nothing
  if (reply && to === DISPATCHER) {
    try {
      await recordReply(Number(reply[1]), text)
    } catch (error) {
      // the reply went out; a failed record keeps the item needing him, so it is seen again
      console.error(
        `POST /api/v1/messages recording the reply to #i${reply[1]} failed:`,
        (error as Error).message,
      )
    }
  }
  return {
    at: result.at,
    sessionId: result.sessionId,
    ...(threadId && !replayed && { threadId }),
  }
}

const STORE_STATUS: Record<StoreRefusal["code"], [ContentfulStatusCode, ErrorCode]> = {
  EMPTY: [400, "VALIDATION_ERROR"],
  FULL: [507, "INSUFFICIENT_STORAGE"],
  TOO_LARGE: [413, "PAYLOAD_TOO_LARGE"],
  UNSUPPORTED: [415, "UNSUPPORTED_MEDIA_TYPE"],
}

// The upload route's work once the request is through its guards: the file kept in the attachments folder, or its refusal as the API's error with the reason's code under `attachment`. Nothing about the file reaches the database.
export async function uploadAttachment(
  file: File,
  store: (bytes: Uint8Array, name: string) => Promise<StoreRefusal | Stored> = storeAttachment,
): Promise<{ id: string; kind: Attachment["kind"]; size: number }> {
  const result =
    file.size > MAX_ATTACHMENT_BYTES
      ? ({ code: "TOO_LARGE", ok: false, reason: TOO_LARGE_REASON } as const)
      : await store(new Uint8Array(await file.arrayBuffer()), file.name)
  if (!result.ok) {
    const [status, code] = STORE_STATUS[result.code]
    throw new ApiError(status, code, result.reason, { attachment: result.code })
  }
  return { id: result.id, kind: result.kind, size: result.size }
}

// What a browser may do with a file the dashboard serves: show it as the type the dashboard gave it and nothing else, never run it, and save rather than show anything but an image.
export const servedHeaders = (file: Attachment): Record<string, string> => ({
  "cache-control": "private, max-age=3600",
  "content-disposition": file.kind === "image" ? "inline" : "attachment",
  "content-security-policy": "default-src 'none'; sandbox",
  "content-type": contentType(file.id),
  "x-content-type-options": "nosniff",
})

// The serve route's work: the file's bytes with servedHeaders, or a 404 once it has gone; with download, saved under the name it gives.
export async function serveAttachment(
  id: string,
  read: (id: string) => ReturnType<typeof readAttachment> = readAttachment,
  download?: (id: string) => Promise<string>,
): Promise<Response> {
  const found = await read(id)
  if (!found) {
    throw new ApiError(
      404,
      "NOT_FOUND",
      "No attachment by that id: files are kept for a week after they arrive",
    )
  }
  const headers = servedHeaders(found.file)
  if (download)
    headers["content-disposition"] = attachmentDisposition(await download(found.file.id))
  return new Response(found.bytes, { headers })
}

// A body is cut off once it outgrows a file and its form's framing, before it is all read.
export const uploadBodyLimit = bodyLimit({
  maxSize: MAX_ATTACHMENT_BYTES + 64 * 1024,
  onError: () => {
    throw new ApiError(413, "PAYLOAD_TOO_LARGE", TOO_LARGE_REASON, { attachment: "TOO_LARGE" })
  },
})

export const uploadForm = sValidator("form", z.object({ file: z.instanceof(File) }), (result) => {
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Send one file as the form field file", {
      issues: result.error,
    })
  }
})

// A card's id: the id of the tool call that raised it (toolu_01...), in the charset the Messages API gives a tool_use id.
const CARD_REQUEST_ID = /^[A-Za-z0-9_-]{1,100}$/

export const feedParamsSchema = z.object({
  requestId: z.string().regex(CARD_REQUEST_ID),
  sessionId: z.string().min(1).max(200),
})

export const feedAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    answers: z
      .array(
        z.object({
          choices: z.array(z.string().min(1).max(500)).max(50),
          text: z.string().max(TEXT_LIMIT).nullable(),
        }),
      )
      .min(1)
      .max(20),
    kind: z.literal("question"),
  }),
  z.object({ kind: z.literal("permission"), mode: z.enum(PERMISSION_MODES) }),
  z.object({
    feedback: z.string().max(TEXT_LIMIT).nullable().default(null),
    kind: z.literal("plan"),
    mode: z.enum(PLAN_MODES),
  }),
])

const FEED_FAILURE_STATUS: Record<FeedFailure, [ContentfulStatusCode, ErrorCode]> = {
  BUSY: [409, "CONFLICT"],
  DISABLED: [403, "FORBIDDEN"],
  FORBIDDEN: [403, "FORBIDDEN"],
  INTERRUPTED: [502, "SESSIONS_FAILED"],
  INVALID: [400, "VALIDATION_ERROR"],
  NOT_FOUND: [404, "NOT_FOUND"],
  NOT_PENDING: [409, "CONFLICT"],
  SESSIONS_FAILED: [502, "SESSIONS_FAILED"],
  TERMINAL_ONLY: [403, "FORBIDDEN"],
  UNCONFIRMED: [502, "SESSIONS_FAILED"],
}

// The answer route's work once the request is through its guards: the answer (which judges who may give it), its refusal turned into the API's error envelope with the reason's code under `feed`.
export async function answerPrompt(
  input: FeedAnswering,
  answer: (input: FeedAnswering) => Promise<FeedResult> = answerFeed,
): Promise<{ at: string }> {
  const result = await answer(input)
  if (!result.ok) {
    const [status, code] = FEED_FAILURE_STATUS[result.code]
    throw new ApiError(status, code, result.reason, { feed: result.code })
  }
  return { at: result.at }
}

export const modeSchema = z.object({ mode: z.enum(HOSTED_MODES) })

const MODE_FAILURE_STATUS: Record<
  Extract<ModeResult, { ok: false }>["code"],
  [ContentfulStatusCode, ErrorCode]
> = {
  DISABLED: [403, "FORBIDDEN"],
  FORBIDDEN: [403, "FORBIDDEN"],
  NOT_FOUND: [404, "NOT_FOUND"],
}

// The mode route's work once the request is through its guards: the change (which judges who may make it), its refusal turned into the API's error envelope with the reason's code under `mode`.
export async function changeMode(
  input: ModeChanging,
  change: (input: ModeChanging) => Promise<ModeResult> = changeHostedMode,
): Promise<{ at: string; mode: ModeChanging["mode"] }> {
  const result = await change(input)
  if (!result.ok) {
    const [status, code] = MODE_FAILURE_STATUS[result.code]
    throw new ApiError(status, code, result.reason, { mode: result.code })
  }
  return { at: result.at, mode: result.mode }
}

// The setting route's work once the request is through its guards: a model or an effort for a dispatcher or the assistant, typed as its one slash command through deliver() under the composer's id, or for the session the dashboard hosts, set through the SDK by changeHostedSetting(); any other session is refused as FORBIDDEN before anything is sent, and a delivery's refusal is turned into the API's error envelope with its code under `delivery`.
export async function changeSetting(
  { id, sessionId, setting }: { id?: string; sessionId: string; setting: SessionSetting },
  actor: Delivery["actor"],
  live: () => Promise<Live> = listLive,
  send: (delivery: Delivery) => Promise<DeliveryResult> = deliver,
  setHosted: (changing: SettingChanging) => Promise<DeliveryResult> = changeHostedSetting,
): Promise<{ at: string; sessionId: string }> {
  const worker = (await live()).workers.find((w) => w.sessionId === sessionId)
  if (!worker) throw new ApiError(404, "NOT_FOUND", "No live session with that id")
  const typed = DISPATCHERS.includes(worker.name) || Boolean(worker.assistant)
  if (!typed && !worker.hosted) {
    throw new ApiError(
      403,
      "FORBIDDEN",
      `A model or effort is set on ${[...DISPATCHERS, "the assistant", SDK_PROBE].join(", ")} only`,
    )
  }
  const result = typed
    ? await send({ actor, setting, text: "", to: worker.name, ...(id && { id }) })
    : await setHosted({ actor, sessionId, setting })
  if (!result.ok) {
    const [status, code] = FAILURE_STATUS[result.code]
    throw new ApiError(status, code, result.reason, { delivery: result.code })
  }
  return { at: result.at, sessionId: result.sessionId }
}

const transcriptQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(200),
})

const liveSession = async (sessionId: string) => {
  const live = await listLive()
  const worker = live.workers.find((w) => w.sessionId === sessionId)
  if (!worker) throw new ApiError(404, "NOT_FOUND", "No live session with that id")
  return { live, worker }
}

// A page of threads, the first when none is named; a thread by its 4-character id, so nothing a path could carry reaches the query.
export const threadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10000).default(1),
})

export const threadParamsSchema = z.object({ id: threadIdSchema })

export const musicSearchQuerySchema = z.object({
  next: z.string().max(8000).optional(),
  q: z.string().trim().min(1).max(200),
})

const invalidInput = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
  }
}

const dashboardRoutes = new Hono<{ Variables: Session }>()
  .get(
    "/agents",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Every agent the roster lists or herdr runs, for the dashboard: its role, task, live state, last activity, last report to the dispatcher, branch and pull request, with the roster's backlog still waiting, in the order they go out",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => c.json({ data: await agentsBoard() }),
  )
  .get(
    "/music/search",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "The sidebar player's search: one page of YouTube's videos for `q` (about 20), each with its id, title, channel and length, read from YouTube's results page, and `next`, the token that reads the page after it (passed back as `next`), null at the end. Read-only.",
      responses: { 200: { description: "OK" }, ...validationErrorResponses, ...authErrorResponses },
    }),
    sValidator("query", musicSearchQuerySchema, invalidInput),
    async (c) => {
      const { next, q } = c.req.valid("query")
      return c.json({ data: await searchYouTube(q, next) })
    },
  )
  .get(
    "/ops",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "The ops jobs that run as scripts with no Claude session, A to Z: one for each `ops/ops-*.json` heartbeat in the data folder and each job `ops/jobs.json` lists, with or without the `ops-` prefix (`report.json`, `alerts.log` and any other file no row names are not jobs), so a new job shows with no code change: what each does (core's line for a registry job, else its own `jobs.json` description, else the generic `NO_DESCRIPTION` line), its status (`running`; `waiting` with the reason after `waiting: ` in its last result, when it has nothing to read yet; `failing` with its last result; `down` when its file is malformed, its loop has exited, its process is gone or it has not beaten for three cycles, with the reason), its last beat, and `paused`: true for a job `ops/jobs.json` marks disabled, which the sidebar leaves out and the System page lists as Paused. A job jobs.json expects to run with no heartbeat file is `down`. Beside those, `callsModel` and `model`, the marks jobs.json gives each job: the sidebar shows a model label, or AI, on a job marked callsModel. Read-only.",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => c.json({ data: await readOps() }),
  )
  .get(
    "/stacks",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Every worktree of every project this machine works in (this checkout's and each live session's folder's, read from git's own files), by project, then branch, A to Z, for the Inbox's Preview row: each its branch (null when detached), its name (its host's first label while it runs, else its folder's), its path, its project (the origin's repository name), the session working in it (null when none), and its stack's https URL while `bun run dev` serves it, from the portless route whose process group its stack's record names, else null, and `vibe`, true for a Vibeground `POST /api/v1/stacks/start` started (its `.turbo/vibe.json`); then each web stack portless serves that no worktree claims, under its app's name, with no path, branch or session. API hosts and aliases are left out, and a fixture stack lists the fixture's made-up worktrees. Read-only.",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => c.json({ data: await readStacks() }),
  )
  .post(
    "/stacks/start",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Start a stopped worktree from the Inbox's Preview row as a Vibeground, on the owner's click: `path` names one `GET /api/v1/stacks` lists, a linked worktree of a Playground-shaped checkout (its own `.env.example` and `packages/db/drizzle`) on a branch, run as it stands whatever its parent. It gets a Postgres container of its own on loopback, seeded by one `pg_dump` inside the live database's container (every table, `claude_*` without its rows), the only read of the live database; the branch's own migrations run on the copy; its `.env` starts from its own `.env.example` with the copy's URL and `PLAYGROUND_LIVE_READS=true` (an `.env` already there is kept aside and put back on Stop); then `bun run dev` starts in it as this user, in its own process group. Refused (409) while the 5-minute load is over 30, or over 15 with a Vibeground running, and for a running or already started worktree, the live dashboard's, a checkout's own folder or a non-Playground one; a failed seed removes the copy. A fixture stack marks its made-up worktree running instead. Returns the dump's size and the time taken.",
      responses: {
        200: {
          description: "Started",
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.object({ bytes: z.number(), ms: z.number() }) })),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        409: errorResponse("CONFLICT", "The worktree cannot start, with the reason"),
      },
    }),
    vibeLimiter,
    sValidator("json", vibeSchema, invalidInput),
    async (c) => {
      try {
        return c.json({ data: await startVibe(c.req.valid("json").path) })
      } catch (error) {
        if (error instanceof VibeError) throw new ApiError(409, "CONFLICT", error.message)
        throw error
      }
    },
  )
  .post(
    "/stacks/stop",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Stop a Vibeground on the owner's click: `path` names a worktree `GET /api/v1/stacks` lists with `vibe: true`. Runs `bun run dev:stop` in it, which signals only the process groups its stack recorded, removes its copy's container with `docker rm -fv`, and puts its `.env` back as it was before Start; the worktree stays. Refused (409) for a stack Start did not start. A fixture stack marks its made-up worktree stopped instead.",
      responses: {
        200: {
          description: "Stopped",
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.object({ stopped: z.literal(true) }) })),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        409: errorResponse("CONFLICT", "The stack cannot stop, with the reason"),
      },
    }),
    vibeLimiter,
    sValidator("json", vibeSchema, invalidInput),
    async (c) => {
      try {
        await stopVibe(c.req.valid("json").path)
        return c.json({ data: { stopped: true as const } })
      } catch (error) {
        if (error instanceof VibeError) throw new ApiError(409, "CONFLICT", error.message)
        throw error
      }
    },
  )
  .get(
    "/system",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "This machine's room for more workers, read every 30s while anyone reads it: RAM used and free with macOS's memory pressure, swap, the load average against the cores, disk free, Docker's VM and containers, each live session's footprint (its claude process, everything under it, and the dev stack it serves with that stack's Postgres container) and processes left running in a checkout with no session, an hour of totals, the usage windows the usage job writes, `account`, the Claude account the usage windows reflect (its email and display name alone), `pulls`, the pull requests page of the checkout's GitHub origin, and `update`, how many commits this build is behind the branch its checkout follows (main on origin/main, canary and the live dashboard's branch on origin/canary, fetched at most every 10 minutes in the background) with the newest one's title and time, and `live` when that branch is the live dashboard's. `capacity.line` says how many more workers fit and what limits them, `capacity.orchestrators` how many more orchestrators (a claude with no dev stack, `capacity.perOrchestrator`); `capacity.idle.line` how much stopping a worker's dev stack idle for 15 minutes would free. Read-only but for the update check's fetch, which moves only origin/<upstream>: every other command it runs only reports.",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => c.json({ data: await systemReport() }),
  )
  .get(
    "/threads",
    describeRoute({
      tags: ["Dashboard"],
      description: `One page of the owner's open threads, ${THREADS_PER_PAGE} to a page: pinned first, the newest pin on top, then the rest by updatedAt, newest first, with archived threads left out. Each carries \`unread\`, the count of its messages someone else wrote stamped after lastReadAt (every one while it is null), and \`firstMessageId\`, the uuid of its first message. Read-only.`,
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: resolver(z.object({ data: threadsPageSchema })) },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
      },
    }),
    sValidator("query", threadsQuerySchema, invalidInput),
    async (c) => c.json({ data: await listThreads(db, c.req.valid("query").page) }),
  )
  .patch(
    "/threads/:id",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Change one thread, by its 4-character id: `archived` and `pinned` set their time to now or clear it, `read` true marks every message read now and false marks every one unread again, and `title` renames it. At least one field is given. Answers the thread as it now reads.",
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: resolver(z.object({ data: threadSchema })) },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    sValidator("param", threadParamsSchema, invalidInput),
    sValidator("json", threadPatchSchema, invalidInput),
    async (c) => {
      const changed = await patchThread(db, c.req.valid("param").id, c.req.valid("json"))
      if (!changed) throw new ApiError(404, "NOT_FOUND", "No thread with that id")
      return c.json({ data: changed })
    },
  )
  .get(
    "/threads/:id/messages",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "One thread, by its 4-character id, with its messages in its own order (threadSeq), each in the chat's entry shape (`entries`); another thread's messages and the chat's untagged ones are left out. Read-only: opening the thread marks it read through PATCH.",
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  data: z.object({
                    entries: z.array(z.record(z.string(), z.unknown())),
                    thread: threadSchema,
                  }),
                }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    sValidator("param", threadParamsSchema, invalidInput),
    async (c) => {
      const found = await threadMessages(db, c.req.valid("param").id)
      if (!found) throw new ApiError(404, "NOT_FOUND", "No thread with that id")
      return c.json({ data: found })
    },
  )
  .get(
    "/board",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "The board as the WebSocket's workers or error frame sends it, for a client that reads with no socket (the hosted relay): null when no frame came within 10s",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => c.json({ data: await boardFrame() }),
  )
  .get(
    "/workers",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Every live Claude Code session herdr runs, with its light, task, any picker waiting on you, and each prompt it waits on as a card (`feed`: a picker's questions, a permission request with the tool's whole input, a plan)",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    async (c) => {
      const { workers } = await listLive()
      return c.json({ data: workers })
    },
  )
  .get(
    "/workers/:sessionId/transcript",
    describeRoute({
      tags: ["Dashboard"],
      description: "The latest entries of one live session's transcript",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    sValidator("query", transcriptQuerySchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const { sessionId } = c.req.param()
      const { live } = await liveSession(sessionId)
      const path = live.transcripts.get(sessionId)
      const entries = path ? await readTail(path, c.req.valid("query").limit) : []
      return c.json({ data: entries })
    },
  )
  .get(
    "/workers/:sessionId/skills",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "The skills one live session may run as a command, A to Z, for the composer's / menu: the same list a message's leading / is checked against, read from the session's own skills folders, each skill's frontmatter allowing a person to invoke it. The folders come from the live session its id names, never from the request. Read-only.",
      responses: {
        200: {
          description: "OK",
          content: {
            "application/json": { schema: resolver(z.object({ data: z.array(z.string()) })) },
          },
        },
        ...authErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    async (c) => {
      const { worker } = await liveSession(c.req.param("sessionId"))
      return c.json({ data: [...(await sessionSkills(worker.cwd))].sort() })
    },
  )
  .get(
    "/workers/:sessionId/agents/:agentId/transcript",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "The latest steps of one subagent a live session ran (an Agent call), read from its own transcript beside the session's",
      responses: { 200: { description: "OK" }, ...authErrorResponses },
    }),
    sValidator(
      "param",
      z.object({ agentId: z.string().regex(AGENT_ID_PATTERN), sessionId: z.string() }),
      (result) => {
        if (!result.success) {
          throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
        }
      },
    ),
    sValidator("query", transcriptQuerySchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const { agentId, sessionId } = c.req.valid("param")
      const { live } = await liveSession(sessionId)
      const session = live.transcripts.get(sessionId)
      const path = session ? subagentPath(session, agentId) : null
      const entries = path
        ? await readTail(path, c.req.valid("query").limit, { sidechain: true })
        : []
      return c.json({ data: entries })
    },
  )
  .post(
    "/messages",
    describeRoute({
      tags: ["Dashboard"],
      description: `Send a message to a live session as the owner, and record it in the console's activity. Phase 2a sends to each dispatcher (${DISPATCHERS.join(" and ")}) and to the session the roster seats as the assistant, typed into its terminal as if the owner typed it, and to ${SDK_PROBE}, the session the dashboard hosts on the Agent SDK, whose message goes on its input rather than into a terminal; a message to any other session is refused as FORBIDDEN before anything is sent. \`attachments\` names up to ${MAX_ATTACHMENTS} uploaded files by id; each one's absolute path follows the words on an "Attached:" line, for the session to Read. \`id\`, the composer's own for the message, makes a retry safe: a message already recorded under it is answered as delivered, not typed again. \`queuedAt\`, with an \`id\`, is the time an earlier try's QUEUED refusal gave under \`queuedAt\` (when the message was pasted), so an API that restarted since reads the message again rather than typing it twice. A refusal names its reason in \`delivery\`: COMMAND, EMPTY, INPUT_NOT_EMPTY (nothing typed, or, for a message with an \`id\` to a herdr session, its paste left unsent in the box, which its retry presses Enter on and, for a new thread, names under \`threadId\`), INTERRUPTED (typing began and did not finish, or a QUEUED message left the screen with a transcript that cannot be read back to when it was queued, so whether it went is not known and it is never retried unseen), LOST (a QUEUED message that neither the session's screen nor its transcript, read back to when it was queued, shows 10 minutes after it was queued, which a retry sends again), NOT_FOUND, ON_PICKER, QUEUED (Claude Code holds the message, in its box while it compacts or in its queue while it works, and takes it once free: a retry under the same \`id\` types nothing and reads it again, answering it delivered once its transcript shows it), SESSIONS_FAILED or TOO_LONG; an attachment that is gone is a 404 naming it under \`attachment\` (GONE) and \`id\`. A message naming an inbox item (\`re #iN\`) records the reply on it once sent, which takes it off the Inbox square's count while it stays in his list until its poster closes it. \`threadId\`, for the primary dispatcher alone, puts that thread's marker (\`[thread:<id>] \`) before the words, which routes the message to the thread once ingest brings it; a thread that does not exist is a 404 before anything is sent. \`newThread: true\`, in place of \`threadId\`, opens a thread titled from the message's first line and sends the message as its first, naming it under \`threadId\`.`,
      responses: {
        200: {
          description: "Sent and recorded",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  data: z.object({
                    at: z.string(),
                    sessionId: z.string(),
                    threadId: threadIdSchema.optional(),
                  }),
                }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        409: errorResponse(
          "CONFLICT",
          "The session cannot take it now: it waits on a picker (ON_PICKER), its input holds something (INPUT_NOT_EMPTY), Claude Code has the message or takes it once free (QUEUED), or a held message was lost (LOST)",
        ),
        502: errorResponse(
          "SESSIONS_FAILED",
          "the sessions could not be read, or the send was refused before anything was typed and again on a second try (SESSIONS_FAILED, which the outbox retries), or typing began and did not finish (INTERRUPTED), which reads Delivered once its transcript shows it",
        ),
      },
    }),
    messageLimiter,
    sValidator("json", messageSchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const user = c.get("user")
      const data = await sendMessage(c.req.valid("json"), { email: user.email, id: user.id })
      return c.json({ data })
    },
  )
  .post(
    "/workers/:sessionId/feed/:requestId",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Answer a prompt a live session waits on, as the owner would in its terminal: a picker its herdr pane shows, answered by keys, or for the session the dashboard hosts on the Agent SDK, one its canUseTool callback holds. A picker's questions (each by option labels, or the person's own words), a permission request (once or deny, never always), or a plan (manual, which starts it with edits still asking, or deny with an optional note). Permission and plan answers go only while PLAYGROUND_APPROVALS_ENABLED is on. A herdr session's picker is typed only while its pane shows the question the card shows (answerHerdr() in feed.ts), and its permission or plan is answered in its terminal alone; a hosted session's answer goes straight to its callback. The answer is recorded in the console's activity without its words. A refusal names its reason in `feed`: BUSY, DISABLED, FORBIDDEN, INTERRUPTED (keys went into a herdr session's pane, yet its picker still shows or changed partway), INVALID, NOT_FOUND, NOT_PENDING, SESSIONS_FAILED, TERMINAL_ONLY (a herdr session's permission or plan) or UNCONFIRMED (the keys went, but the pane could not be read to see them land).",
      responses: {
        200: {
          description:
            "Answered: the prompt has left the pane, or the hosted session's callback has its answer",
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.object({ at: z.string() }) })),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        409: errorResponse(
          "CONFLICT",
          "The prompt no longer waits (NOT_PENDING), or it is being answered already (BUSY)",
        ),
        502: errorResponse(
          "SESSIONS_FAILED",
          "The session's pane could not be read (SESSIONS_FAILED), keys went yet the prompt still shows (INTERRUPTED), or they went and could not be seen to land (UNCONFIRMED): look at the session",
        ),
      },
    }),
    answerLimiter,
    sValidator("param", feedParamsSchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    sValidator("json", feedAnswerSchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const user = c.get("user")
      const { requestId, sessionId } = c.req.valid("param")
      const data = await answerPrompt(
        {
          actor: { email: user.email, id: user.id },
          answer: c.req.valid("json"),
          approver: user,
          requestId,
          sessionId,
        },
        hosts(sessionId) ? answerHosted : answerFeed,
      )
      return c.json({ data })
    },
  )
  .post(
    "/workers/:sessionId/mode",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Change the permission mode of the session the dashboard hosts on the Agent SDK, as Shift+Tab does in a terminal: default, acceptEdits, plan or bypassPermissions, through the SDK's setPermissionMode. A mode approves the session's later actions, so only the owner changes it, and only while PLAYGROUND_APPROVALS_ENABLED is on. The change is recorded in the console's activity with the old and the new mode. A refusal names its reason in `mode`: DISABLED, FORBIDDEN or NOT_FOUND.",
      responses: {
        200: {
          description: "Changed: the session runs in the new mode",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ data: z.object({ at: z.string(), mode: z.enum(HOSTED_MODES) }) }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    modeLimiter,
    sValidator("param", z.object({ sessionId: z.string().min(1).max(200) }), (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    sValidator("json", modeSchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const user = c.get("user")
      const data = await changeMode({
        actor: { email: user.email, id: user.id },
        approver: user,
        mode: c.req.valid("json").mode,
        sessionId: c.req.valid("param").sessionId,
      })
      return c.json({ data })
    },
  )
  .post(
    "/workers/:sessionId/setting",
    describeRoute({
      tags: ["Dashboard"],
      description: `Set the model or the effort of a dispatcher (${DISPATCHERS.join(" or ")}), of the session the roster seats as the assistant, or of ${SDK_PROBE}, the session the dashboard hosts on the Agent SDK, as the owner's own pick in the composer: \`model\` one of ${SESSION_MODELS.join(", ")}, or \`effort\` one of ${SESSION_EFFORTS.join(", ")}, never both. For a dispatcher the API builds the one slash command (\`/model <alias>\` or \`/effort <level>\`) from those lists and types it as a message is typed; the hosted session takes it through the SDK's own calls. Either way it records a dashboard.setting row naming the session and the value. Any other session is refused as FORBIDDEN before anything is sent. \`id\`, the composer's own for the pick, lets a dispatcher that holds the command while it compacts read QUEUED rather than INTERRUPTED, and makes a retry under it safe, as the message route's does. A delivery's refusal names its reason in \`delivery\`, as the message route's does.`,
      responses: {
        200: {
          description:
            "Set: a dispatcher runs the typed command, or the hosted session has taken the value",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ data: z.object({ at: z.string(), sessionId: z.string() }) }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    settingLimiter,
    sValidator("param", z.object({ sessionId: z.string().min(1).max(200) }), invalidInput),
    sValidator("json", settingRequestSchema, invalidInput),
    async (c) => {
      const user = c.get("user")
      const { id, ...setting } = c.req.valid("json")
      const data = await changeSetting(
        { id, sessionId: c.req.valid("param").sessionId, setting },
        { email: user.email, id: user.id },
      )
      return c.json({ data })
    },
  )
  .post(
    "/workers/:sessionId/restart",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Restart a live session whose Claude login expired, with no terminal step: spawn.sh closes the pane it opened and resumes the same conversation in its folder, a reviewer or tester naming the PRs its roster row lists (`--pr`: its prs, else its pr), on `account` (a Claude account added in Settings > Accounts, with its token kept) or, with none, on this Mac's own login. A fixture stack runs nothing and clears the session's login block. A refusal names its reason: NOT_FOUND for no such live session or no such kept account, CONFLICT for a reviewer or tester whose row names no pull request, refused before the close since spawn.sh would refuse its resume, ERROR for spawn.sh's own words.",
      responses: {
        200: {
          description: "Restarted: the session runs again on the account named",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  data: z.object({ account: z.string().nullable(), restarted: z.literal(true) }),
                }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        409: errorResponse(
          "CONFLICT",
          "A reviewer or tester whose roster row names no pull request, so its resume after the close would be refused",
        ),
        502: errorResponse("ERROR", "spawn.sh refused or failed, its reason passed through"),
      },
    }),
    restartLimiter,
    sValidator("param", z.object({ sessionId: z.string().min(1).max(200) }), (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    sValidator("json", z.object({ account: z.email().max(254).optional() }), (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const { sessionId } = c.req.valid("param")
      const { account } = c.req.valid("json")
      const worker = (await listLive()).workers.find((w) => w.sessionId === sessionId)
      if (!worker) throw new ApiError(404, "NOT_FOUND", "No live session has that id")
      const kept = listAccounts().some(
        (row) =>
          row.provider === "claude" &&
          row.stored &&
          row.email?.toLowerCase() === account?.toLowerCase(),
      )
      if (account && !kept)
        throw new ApiError(404, "NOT_FOUND", `No Claude account ${account} is kept`)
      // The close ends the row, so a checker's PRs are read before it: its resume names them with --pr, or spawn.sh refuses it.
      const row = (await readRoster()).roster?.agents.find((a) => a.name === worker.name)
      const prs = restartPrs(["reviewer", "tester"].includes(kindOf(worker.name, row) ?? ""), row)
      if (prs === null)
        throw new ApiError(
          409,
          "CONFLICT",
          `${worker.name} is a reviewer or tester whose roster row names no pull request, so spawn.sh would refuse its resume after the close: name the PR it serves with roster.ts set ${worker.name} prs=<pull url>, then restart it`,
        )
      const restarted = await restartSession({
        account,
        cwd: worker.cwd,
        name: worker.name,
        prs,
        sessionId,
      })
      if (restarted.status === "refused") throw new ApiError(502, "ERROR", restarted.detail)
      return c.json({ data: { account: account ?? null, restarted: true as const } })
    },
  )
  .post(
    "/managers/order",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Set the order of the sidebar's Orchestrators rows after a drag: the manager session names, first to last, written whole to sidebar/managers-order.json in the data folder. At most 20 names, none twice, each a manager (the planner, the builder, ops or the optimizer, or an agent the roster gives the manager role or a manager kind), never the dispatcher; a refusal names the name it will not take. Returns the order as written.",
      responses: {
        200: {
          description: "Written",
          content: {
            "application/json": {
              schema: resolver(
                z.object({ data: z.object({ names: z.array(z.string()), updatedAt: z.string() }) }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        500: errorResponse("INTERNAL_SERVER_ERROR", "managers-order.json could not be written"),
      },
    }),
    managersOrderLimiter,
    sValidator("json", managersOrderSchema, (result) => {
      if (!result.success) {
        throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
      }
    }),
    async (c) => {
      const { names } = c.req.valid("json")
      const { roster } = await readRoster()
      const unknown = unknownManager(names, roster?.agents ?? [])
      if (unknown !== null) {
        throw new ApiError(400, "VALIDATION_ERROR", `${unknown} is not a manager`)
      }
      try {
        return c.json({ data: await writeManagersOrder(names) })
      } catch {
        throw new ApiError(500, "INTERNAL_SERVER_ERROR", "The order could not be saved")
      }
    },
  )
  .delete(
    "/managers/order",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Forget the order set by dragging the sidebar's Orchestrators rows, so they go A to Z by roster title again: removes sidebar/managers-order.json in the data folder. A missing file is fine.",
      responses: {
        200: {
          description: "Cleared",
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.object({ names: z.array(z.string()) }) })),
            },
          },
        },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        500: errorResponse("INTERNAL_SERVER_ERROR", "managers-order.json could not be removed"),
      },
    }),
    managersOrderLimiter,
    async (c) => {
      try {
        await clearManagersOrder()
      } catch {
        throw new ApiError(500, "INTERNAL_SERVER_ERROR", "The order could not be cleared")
      }
      return c.json({ data: { names: [] } })
    },
  )
  .post(
    "/attachments",
    describeRoute({
      tags: ["Dashboard"],
      description: `Keep one file (multipart field \`file\`, at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB) in the owner-only attachments folder, for a message to carry by its id. Images (PNG, JPEG, GIF, WebP), PDFs and text, told by their bytes; files leave the folder a week after they arrive. A refusal names its reason in \`attachment\`: EMPTY, FULL, TOO_LARGE or UNSUPPORTED.`,
      responses: {
        200: {
          description: "Kept",
          content: {
            "application/json": {
              schema: resolver(
                z.object({
                  data: z.object({
                    id: z.string(),
                    kind: z.enum(["image", "pdf", "text"]),
                    size: z.number(),
                  }),
                }),
              ),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        413: errorResponse("PAYLOAD_TOO_LARGE", "The file is larger than a file may be"),
        415: errorResponse("UNSUPPORTED_MEDIA_TYPE", "The file is not an image, a PDF or text"),
        507: errorResponse("INSUFFICIENT_STORAGE", "The attachments folder is full"),
      },
    }),
    attachmentLimiter,
    uploadBodyLimit,
    uploadForm,
    async (c) => {
      const data = await uploadAttachment(c.req.valid("form").file)
      return c.json({ data })
    },
  )
  .post(
    "/debug/paste",
    describeRoute({
      tags: ["Dashboard"],
      description: `Temporary, while a lost paste is chased: keep the browser's paste log, at most ${PASTE_REPORT_ENTRIES} entries of element names, focus, where each Cmd+V reached, mounts, lengths, delays and clipboard types and nothing else, never the words, as one owner-only file under debug/paste in the data folder, when a Cmd+V aimed at the message box brought no paste within a second, a Cmd+V reached nothing that takes text, a paste carried nothing, the box went empty within 3 seconds of a paste the box let in, with no key or press of the owner's, or a page load finds a miss newer than the last one a load sent. The newest ${PASTE_REPORTS_KEPT} files are kept.`,
      responses: {
        201: {
          description: "Kept",
          content: {
            "application/json": {
              schema: resolver(z.object({ data: z.object({ file: z.string() }) })),
            },
          },
        },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        413: errorResponse(
          "PAYLOAD_TOO_LARGE",
          `The report is larger than ${PASTE_REPORT_BYTES / 1024} KB`,
        ),
      },
    }),
    pasteReportLimiter,
    pasteReportBodyLimit,
    pasteReportBody,
    async (c) => c.json({ data: { file: await storePasteReport(c.req.valid("json")) } }, 201),
  )
  .get(
    "/attachments/:id",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "One kept attachment's bytes, by the id its upload returned: an image shown as itself, anything else saved as a download, never run",
      responses: {
        200: { description: "The file" },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    (c) => serveAttachment(c.req.param("id")),
  )
  .get(
    "/ws",
    describeRoute({
      tags: ["Dashboard"],
      description:
        "Live frames over a WebSocket: { type: workers } whenever a session changes, { type: entries } as transcripts grow, { type: error } when the sessions cannot be read, and { type: activity } for the one chat the client has open, once it sends { type: watch, sessionId } (null to stop): the session's spinner line as verb, elapsed, tokens and thought, read at most once a second while it works, and null when it stops",
      responses: { 101: { description: "Switching Protocols" }, ...authErrorResponses },
    }),
    upgradeWebSocket(() => {
      let unsubscribe: (() => void) | null = null
      // The one chat this socket has open, whose activity it is sent: a new watch replaces it, and the same one again is ignored.
      let unwatch: (() => void) | null = null
      let watching: string | null = null
      return {
        onOpen(_event, ws) {
          unsubscribe = dashboardHub.subscribe((frame) => ws.send(JSON.stringify(frame)))
        },
        onMessage(event, ws) {
          const message = parseWatchMessage(event.data)
          if (!message || message.sessionId === watching) return
          unwatch?.()
          watching = message.sessionId
          unwatch = watching
            ? dashboardHub.watch(watching, (frame) => ws.send(JSON.stringify(frame)))
            : null
        },
        onClose() {
          unwatch?.()
          unwatch = null
          watching = null
          unsubscribe?.()
          unsubscribe = null
        },
      }
    }),
  )

// The guards run on the router's own first segments alone, read from its routes, so its mount at /api/v1 beside user and admin guards none of theirs, and a route added here is guarded with the rest.
const OWN_SEGMENTS = `/:segment{${[...new Set(dashboardRoutes.routes.map((route) => route.path.split("/")[1]))].join("|")}}/*`

// The dashboard lists sessions, reads their transcripts, and streams changes; it writes a message into either dispatcher's or the assistant's terminal through deliver() (P2a), or onto the input of the session the dashboard hosts on the Agent SDK through sdk.ts, and keeps the files such a message carries. Every session's transcript is the owner's business, so the dashboard sits behind the owner rung, and the WebSocket and every write check where they come from before anything else.
export const dashboardRouter = new Hono<{ Variables: Session }>()
  .use("/ws", requireTrustedOrigin)
  .use(OWN_SEGMENTS, guardWrites)
  .use(OWN_SEGMENTS, authMiddleware)
  .use(OWN_SEGMENTS, requireConsoleRole("owner"))
  .route("/", dashboardRoutes)

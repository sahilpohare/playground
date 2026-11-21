import { sValidator } from "@hono/standard-validator"
import type { Session } from "@packages/auth"
import { db } from "@packages/db"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"

import { readAttachment } from "@/lib/dashboard/attachments"
import { deliver } from "@/lib/dashboard/deliver"
import { readsLive } from "@/lib/dashboard/fixture"
import { standingFocus } from "@/lib/dashboard/focus"
import {
  answerInputSchema,
  answerItem,
  attachmentDownloadName,
  dismissItems,
  listItems,
  markRead,
  provideSecret,
  replyInputSchema,
  replyItem,
  retryDelivery,
  revealSecret,
  scheduleItem,
  secretInputSchema,
} from "@/lib/dashboard/inbox"
import { runArgv } from "@/lib/dashboard/run-argv"
import { readFromKeychain, runSink, saveToKeychain } from "@/lib/dashboard/secret-sink"
import { slackUpload } from "@/lib/dashboard/slack-upload"
import { DISPATCHER } from "@/lib/dashboard/workers"
import {
  ApiError,
  authErrorResponses,
  conflictErrorResponses,
  errorResponse,
  forbiddenErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import { dataDir } from "@/lib/sessions/paths"
import { cloneRun, ownerApps, runCli } from "@/lib/store/extensions"
import { ROOT_TIMEOUT_MS } from "@/lib/system/root"
import {
  authMiddleware,
  guardWrites,
  refuseAgent,
  requireConsoleRole,
  requireLoopback,
  requireTrustedOrigin,
} from "@/middlewares"
import { refuseAgentOffFixture } from "@/middlewares/agent"
import { serveAttachment } from "@/routers/dashboard"

const STATUS = { CONFLICT: 409, NOT_FOUND: 404, VALIDATION_ERROR: 400 } as const

const invalid = (result: { success: boolean; error?: unknown }) => {
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "Invalid input", { issues: result.error })
  }
}

const idsInputSchema = z.strictObject({ ids: z.array(z.string().min(1)).min(1).max(200) })

// A secret's refusal names no field and carries no issue, so nothing of what was typed comes back.
const invalidSecret = (result: { success: boolean }) => {
  if (!result.success) {
    throw new ApiError(400, "VALIDATION_ERROR", "A secret takes one value that is not empty")
  }
}

// a card's own Done sets tell, so its update's poster is told done; a shelf's bulk leaves it out and types nothing
const dismissInputSchema = idsInputSchema.extend({ tell: z.literal(true).optional() })

const scheduleInputSchema = z.strictObject({ at: z.iso.datetime() })

// Playground's Inbox (see lib/dashboard/inbox.ts), on the dashboard's owner rung since an answer is typed into a session. Its writes must come from the dashboard's own page on this machine before anything else is read.
export const inboxRouter = new Hono<{ Variables: Session }>()
  .use("/*", guardWrites)
  .use("/attachments/*", requireTrustedOrigin, requireLoopback)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
  .get(
    "/",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Playground's Inbox in priority order: open decisions and drafts, then unread updates, then the rest of the last week, each newest first, with the count of what needs the owner; while `playground focus` stands, `quiet` names each item that came in since it began, an alert update aside, and the count leaves those out until it ends",
      responses: { 200: { description: "OK" }, ...authErrorResponses, ...forbiddenErrorResponses },
    }),
    async (c) => {
      const now = new Date()
      return c.json({ data: await listItems(db, now, await standingFocus(dataDir(), now)) })
    },
  )
  .get(
    "/attachments/:id",
    describeRoute({
      tags: ["Inbox"],
      description:
        "One file an ask, a draft, a Slack decision or a read-only update carries, by the id it was kept under: only for the Dashboard's own page on this machine, which fetches it with its cookie, so a page elsewhere cannot embed it. With ?download it saves under its item's title, the file's own name after it when the item carries several, with the stored file's extension",
      responses: {
        200: { description: "The file" },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
      },
    }),
    (c) =>
      serveAttachment(
        c.req.param("id"),
        readAttachment,
        c.req.query("download") === undefined ? undefined : (id) => attachmentDownloadName(db, id),
      ),
  )
  .post(
    "/dismiss",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Done: move the updates and answered decisions and drafts named to Done at once, where no clock would move them, recording when in their answer, waking any put off or archived, and marking an update read; with tell, a card's own Done, each update's poster is told done through the delivery adapter, and its next edit that changes the card's words brings it back to the list unread, while a shelf's bulk types nothing; an open decision or draft is left as it is",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
      },
    }),
    sValidator("json", dismissInputSchema, invalid),
    async (c) => {
      const user = c.get("user")
      const { ids, tell } = c.req.valid("json")
      const dismissed = await dismissItems(
        db,
        ids,
        new Date(),
        tell && { actor: { email: user.email, id: user.id }, deliver, dispatcher: DISPATCHER },
      )
      return c.json({ data: { dismissed } })
    },
  )
  .post(
    "/read",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Mark the items named read: updates, and open decisions and drafts, which stay open",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
      },
    }),
    sValidator("json", idsInputSchema, invalid),
    async (c) => c.json({ data: { read: await markRead(db, c.req.valid("json").ids) } }),
  )
  .post(
    "/:id/answer",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Answer an open decision (approve, deny, clear to set it aside, or edit with words) or draft (send, or for a Slack draft save it as a draft in Slack, each as written or changed, discard, or clear to set it aside), with his optional note; archive what waits, or an update, out of the list unanswered, or a card on Done not dismissed off Done, or move it back (unarchive), a set-aside one included, each telling its poster nothing; or dismiss it to Done, which sets aside what still waits as clear does, telling its poster set-aside, and marks anything else dismissed, telling its poster dismiss: drop it, with how to close it. With seen, the updatedAt of the card he answered, it is refused when the item has changed since. The answer is kept, then typed into the posting session through the delivery adapter, and that session carries it out; the Dashboard itself sends no message, and only shares a Slack send's files into its channel and thread first (dm upload), a Slack draft's words going with them as their message, each mention and URL in them resolved, a failed share failing the send before anything is typed. An accept, a clone, an apps change, a grant, a guard setting, an own account change and a root step are the decisions whose Approve the Dashboard carries out itself. An accept's Approve: once the answer is kept, it runs the extensions store's accept of <scope> <kind> <key> <rev> from the preview's words, for its first proposal and then each in more, in order, stopping at the first that fails, with no role, records the exit code and one line under accepted, and tells the poster. A clone's Approve, on a stack reading this machine, is refused when a repo's folder is not its scope's in this machine's extensions or is already there; else it runs the extensions store's init --dry-run, refusing a login or repo other than the card's first, then init for that repo and add <scope> <owner/name> for each further one, in order, neither with --yes, so no repo is made, stopping at the first that fails, then, once every repo cloned, seeds the guards' lists from this checkout into the login's scope, keeping each list it already holds, and records one line under cloned, naming the part that failed. An apps change's Approve writes the owner's own desktop-owner-apps list, the login scope's, with the app added or removed, through the store's put with no role, and records its line under listed. A grant's Approve opens System Settings at the pane for its permission (Accessibility or Screen Recording) on this Mac, a stack reading the live machine alone, records its line under opened, and tells the poster to recheck the grant. A guard setting's Approve takes seen, and writes the setting at the card's scope in this machine's extensions, its value or none, which takes it back to its default, and records its line under set. An own account change's Approve takes seen, and sets or clears the own flag on the one Claude account its key names in usage.accounts at the card's scope, every other account as it was, and records its line under owned. A root step's Approve takes seen and, on a Linux stack reading this machine, returns at once and then runs pkexec in the background, up to 5 minutes while the password window waits: an install runs its fixed program text with the card's hashes, and any other step its one installed script, once that script is root's own and matches this checkout's copy; it records its line under rooted, then tells the poster",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
      },
    }),
    refuseAgentOffFixture,
    sValidator("json", answerInputSchema, invalid),
    async (c) => {
      const user = c.get("user")
      const result = await answerItem(db, c.req.param("id"), c.req.valid("json"), {
        accept: runCli(),
        actor: { email: user.email, id: user.id },
        apps: ownerApps(),
        // a stack showing test data reaches no GitHub repo
        clone: readsLive() ? cloneRun() : undefined,
        deliver,
        dispatcher: DISPATCHER,
        // a stack showing test data opens nothing on this Mac's screen
        grant: readsLive() ? (argv) => runArgv(argv) : undefined,
        reveal: readFromKeychain(),
        // a stack showing test data runs nothing as root, and pkexec's window is Linux's
        root:
          readsLive() && process.platform === "linux"
            ? (argv, input) => runArgv(argv, ROOT_TIMEOUT_MS, input)
            : undefined,
        settingsData: dataDir(),
        upload: slackUpload(),
      })
      if (!result.ok) throw new ApiError(STATUS[result.code], result.code, result.message)
      return c.json({ data: result.item })
    },
  )
  .post(
    "/:id/reply",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Reply on a card: his comment alone, typed into the posting session as re #iN: <words> through the delivery adapter, or into the dispatcher once the poster has ended; an open decision or draft with no answer yet records it as his reply and waits on its poster's edit, which returns it to him, or its close, while any other card keeps its answer as it was. A comment that reached no session is refused with why, recording nothing",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        502: errorResponse(
          "SESSIONS_FAILED",
          "The comment reached no session: neither its poster nor, once the poster has ended, the dispatcher took it, with why; nothing is recorded",
        ),
      },
    }),
    sValidator("json", replyInputSchema, invalid),
    async (c) => {
      const user = c.get("user")
      const result = await replyItem(db, c.req.param("id"), c.req.valid("json"), {
        actor: { email: user.email, id: user.id },
        deliver,
        dispatcher: DISPATCHER,
        reveal: readFromKeychain(),
      })
      if (!result.ok) {
        if (result.code === "UNDELIVERED")
          throw new ApiError(502, "SESSIONS_FAILED", result.message)
        throw new ApiError(STATUS[result.code], result.code, result.message)
      }
      return c.json({ data: result.item })
    },
  )
  .post(
    "/:id/retry",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Type an answer whose delivery failed into the posting session again, through the delivery adapter, sharing a Slack send's files first when none were shared, and record how that went",
      responses: {
        200: { description: "OK" },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
      },
    }),
    async (c) => {
      const user = c.get("user")
      const result = await retryDelivery(db, c.req.param("id"), {
        actor: { email: user.email, id: user.id },
        deliver,
        dispatcher: DISPATCHER,
        upload: slackUpload(),
      })
      if (!result.ok) throw new ApiError(STATUS[result.code], result.code, result.message)
      return c.json({ data: result.item })
    },
  )
  .post(
    "/:id/schedule",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Later: push an open decision or draft, or an update, out of the inbox and its count until a time, when it asks again, taking an archived one off the Archive shelf; answering it or replying to it in chat wakes it at once",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
      },
    }),
    sValidator("json", scheduleInputSchema, invalid),
    async (c) => {
      const result = await scheduleItem(db, c.req.param("id"), c.req.valid("json").at)
      if (!result.ok) throw new ApiError(STATUS[result.code], result.code, result.message)
      return c.json({ data: result.item })
    },
  )
  .post(
    "/:id/secret",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Answer an open secret ask with its value, which goes straight to the ask's sink on stdin, once a Vercel environment or once to a Keychain item, and is kept nowhere: the item records only when it was provided and each exit status or saved, and its poster is told that alone",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
      },
    }),
    refuseAgent,
    sValidator("json", secretInputSchema, invalidSecret),
    async (c) => {
      const user = c.get("user")
      const result = await provideSecret(db, c.req.param("id"), c.req.valid("json"), {
        actor: { email: user.email, id: user.id },
        deliver,
        dispatcher: DISPATCHER,
        keychain: saveToKeychain,
        run: runSink,
      })
      if (!result.ok) throw new ApiError(STATUS[result.code], result.code, result.message)
      return c.json({ data: result.item })
    },
  )
  // a POST, so the relay, which carries GETs on RELAY_GETS alone, never carries it
  .post(
    "/:id/reveal",
    describeRoute({
      tags: ["Inbox"],
      description:
        "Show an open reveal card's Keychain item on the owner's click: its value comes back in this one response, never stored, cached or logged, and the agent sign-in is refused",
      responses: {
        200: { description: "OK" },
        ...validationErrorResponses,
        ...authErrorResponses,
        ...forbiddenErrorResponses,
        ...notFoundErrorResponses,
        ...conflictErrorResponses,
      },
    }),
    refuseAgent,
    async (c) => {
      const result = await revealSecret(db, c.req.param("id"), readFromKeychain())
      if (!result.ok) throw new ApiError(STATUS[result.code], result.code, result.message)
      c.header("Cache-Control", "no-store")
      return c.json({ data: { value: result.value } })
    },
  )

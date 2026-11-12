import { auth } from "@packages/auth"
import { site } from "@packages/config/site"
import { db, recordActivity, roleChangeSummary, user as userTable } from "@packages/db"
import { isLocal } from "@packages/env"
import { env } from "@packages/env/api-hono"
import { HARNESS_IDS } from "@packages/settings"
import { and, eq, ne } from "drizzle-orm"
import { type Context, Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { createMiddleware } from "hono/factory"
import { z } from "zod"

import {
  ApiError,
  conflictErrorResponses,
  errorHandler,
  forbiddenErrorResponses,
} from "@/lib/error"
import { type DoneMark, firstRunChecks } from "@/lib/onboard/checks"
import { doneMark } from "@/lib/onboard/done-mark"
import { type Fixes, fixes as shared, readFix, startFix } from "@/lib/onboard/fix"
import { FIX_IDS } from "@/lib/onboard/fix-ids"
import { harnessCards } from "@/lib/onboard/harness"
import { org } from "@/lib/org"
import { signInAs } from "@/lib/sign-in"
import { requireConsoleRole } from "@/middlewares/console"
import { guardWrites, requireThisMachine } from "@/middlewares/dashboard"

// Onboarding in place of a login: the list of what Playground runs on, then the owner made and signed in with no password, and signed in again the same way when the cookie is lost. Same machine is the owner, as first run's setup already holds, so each route takes this machine's requests alone, and every write a trusted origin over loopback first (guardWrites, as every owner-rung router mounts it); finish makes the owner only while none exists, and sign-in signs in the one owner alone. The first run's fixes (lib/onboard/fix.ts) take this machine alone before an owner exists, and the owner's session after. The agent route's LocalAgent is never that owner. Local stacks only.

export type OnboardDeps = {
  createOwner: () => Promise<string>
  enabled: () => boolean
  fixes?: Fixes
  mark?: DoneMark
  owners: () => Promise<string[]>
  signIn: (c: Context, userId: string) => Promise<void>
}

// Every owner but the agent route's LocalAgent, by id.
export const owners = async (): Promise<string[]> =>
  (
    await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(and(eq(userTable.role, "owner"), ne(userTable.email, site.agent.email)))
  ).map((row) => row.id)

// The owner, made with the organisation's owner name and a made-up local address, on the owner rung from the start.
const createOwner = async (): Promise<string> => {
  const ctx = await auth.$context
  let created
  try {
    created = await ctx.internalAdapter.createUser(
      { email: site.owner.email, emailVerified: true, name: org.owner.name },
      { method: "onboard" },
    )
  } catch {
    throw new ApiError(409, "CONFLICT", "The owner was made by another request; sign in instead")
  }
  await db.transaction(async (tx) => {
    await tx
      .update(userTable)
      .set({ role: "owner", roleSetAt: new Date() })
      .where(eq(userTable.id, created.id))
    await recordActivity(tx, {
      action: "role.change",
      actor: { label: "Onboarding" },
      summary: roleChangeSummary(site.owner.email, null, "owner"),
    })
  })
  return created.id
}

const signedIn = z.object({ data: z.object({ signedIn: z.literal(true) }) })
const ok = {
  200: { content: { "application/json": { schema: resolver(signedIn) } }, description: "OK" },
}
const checkSchema = z.object({
  action: z.object({ id: z.enum([...FIX_IDS, "settings"]), label: z.string() }).nullable(),
  detail: z.string(),
  name: z.string(),
  need: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(["MISSING", "ok", "optional", "waiting"]),
})

const owner = requireConsoleRole("owner")

const harnessCard = z.object({
  checks: z.array(checkSchema),
  id: z.enum(HARNESS_IDS),
  label: z.string(),
  ready: z.boolean(),
  refusal: z.string().nullable(),
})

const fixRead = z.object({
  device: z.object({ code: z.string().nullable(), url: z.string() }).nullable(),
  id: z.string(),
  lines: z.array(z.string()),
  reason: z.string().nullable(),
  state: z.enum(["failed", "idle", "ok", "running"]),
})
const fixAnswer = (status: 200 | 202) => ({
  [status]: {
    content: { "application/json": { schema: resolver(z.object({ data: fixRead })) } },
    description: status === 200 ? "OK" : "Started",
  },
})

// The one owner a browser is signed in as, or the refusal in plain words: none yet, or more than one, which no request can tell apart.
const theOwner = (found: string[]): string => {
  if (found.length === 1) return found[0]!
  throw new ApiError(
    409,
    "CONFLICT",
    found.length === 0
      ? "No owner yet; finish onboarding first"
      : `This Mac has more than one owner, so ${site.name} cannot tell which one to sign in: from a browser still signed in as one, open the Console's Users page and make the other an admin`,
  )
}

export const onboardRoutes = (deps: OnboardDeps) => {
  const runner = deps.fixes ?? shared
  const ownerOnceMade = createMiddleware(async (c, next) =>
    (await deps.owners()).length === 0 ? next() : owner(c, next),
  )
  return new Hono()
    .onError(errorHandler)
    .use("/*", guardWrites)
    .use(async (c, next) => (deps.enabled() ? next() : c.notFound()))
    .get(
      "/checks",
      describeRoute({
        tags: ["Onboarding"],
        description:
          "The first run's checks: what Playground runs on, each row with the fix the app runs for it or a plain-words note, the database's, and whether they are done; once done, no check runs and the list is empty.",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: resolver(
                  z.object({ data: z.object({ checks: z.array(checkSchema), done: z.boolean() }) }),
                ),
              },
            },
            description: "OK",
          },
          ...forbiddenErrorResponses,
        },
      }),
      requireThisMachine,
      async (c) =>
        c.json({
          data: await firstRunChecks({
            database: "ok",
            live: c.req.query("live") === "1",
            mark: deps.mark ?? null,
          }),
        }),
    )
    .post(
      "/finish",
      describeRoute({
        tags: ["Onboarding"],
        description:
          "Makes the owner and signs this browser in; once the owner is made, signs this browser in as it, so Continue goes on to the board; refused with two owners.",
        responses: { ...ok, ...forbiddenErrorResponses, ...conflictErrorResponses },
      }),
      requireThisMachine,
      async (c) => {
        const found = await deps.owners()
        await deps.signIn(c, found.length === 0 ? await deps.createOwner() : theOwner(found))
        return c.json({ data: { signedIn: true as const } })
      },
    )
    .post(
      "/sign-in",
      describeRoute({
        tags: ["Onboarding"],
        description: "Signs this browser in again as the one owner; refused with no owner or two.",
        responses: { ...ok, ...forbiddenErrorResponses, ...conflictErrorResponses },
      }),
      requireThisMachine,
      async (c) => {
        await deps.signIn(c, theOwner(await deps.owners()))
        return c.json({ data: { signedIn: true as const } })
      },
    )
    .get(
      "/harnesses",
      describeRoute({
        tags: ["Onboarding"],
        description:
          "Each harness Alpha can start on, as a card: Installed at the version tested, Signed in and its Plan, each a row in the checks' shape with the fix a failed row offers, whether it is ready to start, and a refusal in plain words while its start would be refused (Codex on the live data folder).",
        responses: {
          200: {
            content: {
              "application/json": {
                schema: resolver(z.object({ data: z.object({ harnesses: z.array(harnessCard) }) })),
              },
            },
            description: "OK",
          },
          ...forbiddenErrorResponses,
        },
      }),
      requireThisMachine,
      ownerOnceMade,
      async (c) => c.json({ data: { harnesses: await harnessCards() } }),
    )
    .get(
      "/fix/:id",
      describeRoute({
        tags: ["Onboarding"],
        description:
          "Reads a first-run fix: its state, the last lines it printed, and gh's one-time code while it signs in.",
        responses: { ...fixAnswer(200), ...forbiddenErrorResponses },
      }),
      requireThisMachine,
      ownerOnceMade,
      readFix(runner),
    )
    .post(
      "/fix/:id",
      describeRoute({
        tags: ["Onboarding"],
        description:
          "Starts a first-run fix by its id, one at a time; the database's is refused, since this app runs on one.",
        responses: { ...fixAnswer(202), ...forbiddenErrorResponses, ...conflictErrorResponses },
      }),
      requireThisMachine,
      ownerOnceMade,
      startFix(runner),
    )
}

export const onboardRouter = onboardRoutes({
  createOwner,
  enabled: () => isLocal(env.NODE_ENV),
  mark: doneMark(),
  owners,
  signIn: signInAs,
})

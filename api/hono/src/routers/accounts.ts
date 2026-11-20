import { sValidator } from "@hono/standard-validator"
import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import { z } from "zod"

import { openPrivate, startSetup, submitCode } from "@/lib/accounts/claude-setup"
import {
  authErrorResponses,
  conflictErrorResponses,
  forbiddenErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import { accountsScope, addAccount, listAccounts, removeAccount } from "@/lib/store/accounts"
import { hasLogin } from "@/lib/store/extensions"
import { authMiddleware, guardWrites, requireConsoleRole, type StoreVariables } from "@/middlewares"
import { done, invalid, responses } from "@/routers/store"

const label = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/)
// A pasted token: one line with no spaces, never echoed back in an error.
const token = z.string().trim().min(1).max(4096).regex(/^\S+$/)

// A Claude sign-in: started for the account to add, then named by its id.
const setupSchema = z.strictObject({ email: z.email(), label: label.optional() })
const setupParam = z.strictObject({ id: z.string().min(1) })

export const addSchema = z.discriminatedUnion("provider", [
  z.strictObject({
    email: z.email(),
    label: label.optional(),
    provider: z.literal("claude"),
    token,
  }),
  z.strictObject({ label, provider: z.literal("glm"), token }),
])

export const listResponse = z.object({
  data: z.object({
    accounts: z.array(
      z.object({
        email: z.string().nullable(),
        key: z.string(),
        label: z.string().nullable(),
        own: z.boolean(),
        provider: z.enum(["claude", "glm"]),
        stored: z.boolean(),
      }),
    ),
    login: z.boolean(),
    scope: z.string().nullable(),
  }),
})

// The list, whether the extensions login exists, which Settings asks before it offers Add account, and the scope its Own account switch writes to.
export const accountsList = (data?: string) => ({
  accounts: listAccounts(data),
  login: hasLogin(data),
  scope: accountsScope(data),
})

const who = (c: { get: (key: "user") => unknown }, reason: string) => ({
  actor: (c.get("user") as { id: string }).id,
  author: "owner",
  inboxRef: null,
  reason,
})

// Settings > Accounts, on the owner rung; a write must come from the dashboard's own origin on this machine before anything else is read.
export const accountsRouter = new Hono<{ Variables: StoreVariables }>()
  .use("/*", guardWrites)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
  .get(
    "/",
    describeRoute({
      tags: ["Settings"],
      description:
        "Every account in usage.accounts, with whether its token is kept and whether it is marked own, whether ext init has named the login every account write needs, and the scope a Settings write goes to",
      responses: {
        200: {
          content: { "application/json": { schema: resolver(listResponse) } },
          description: "OK",
        },
        ...authErrorResponses,
        ...forbiddenErrorResponses,
      },
    }),
    (c) => c.json({ data: accountsList() }),
  )
  .post(
    "/",
    describeRoute({
      tags: ["Settings"],
      description:
        "List a Claude account by its email or a GLM key by its label, and keep its token in the Keychain; the token is never returned",
      ...responses(validationErrorResponses, conflictErrorResponses),
    }),
    sValidator("json", addSchema, invalid),
    (c) => {
      const input = c.req.valid("json")
      const added = done(
        addAccount(input, who(c, `add the ${input.provider} account from Settings`)),
      )
      return c.json({ data: { account: added.account } })
    },
  )
  .delete(
    "/:provider/:key",
    describeRoute({
      tags: ["Settings"],
      description: "Take an account out of usage.accounts and its token out of the Keychain",
      ...responses(validationErrorResponses, notFoundErrorResponses, conflictErrorResponses),
    }),
    sValidator(
      "param",
      z.strictObject({ key: z.string().min(1), provider: z.enum(["claude", "glm"]) }),
      invalid,
    ),
    (c) => {
      const { key, provider } = c.req.valid("param")
      const removed = done(
        removeAccount(provider, key, who(c, `remove the ${provider} account from Settings`)),
      )
      return c.json({ data: { key: removed.key, provider: removed.provider } })
    },
  )
  .post(
    "/claude/setup",
    describeRoute({
      tags: ["Settings"],
      description:
        "Start a Claude sign-in for the account to add, ending any earlier one: the browser a fresh profile opens in, or null, its id and the link to open",
      ...responses(validationErrorResponses, conflictErrorResponses),
    }),
    sValidator("json", setupSchema, invalid),
    async (c) => {
      const started = done(await startSetup(c.req.valid("json")))
      return c.json({ data: { browser: started.browser, id: started.id, url: started.url } })
    },
  )
  .post(
    "/claude/setup/:id/code",
    describeRoute({
      tags: ["Settings"],
      description:
        "Paste the code the sign-in shows: the account is listed and its token kept in the Keychain, and confirmed says whether the sign-in named that account; a sign-in for another account is refused and its token dropped; neither the code nor the token is returned",
      ...responses(validationErrorResponses, notFoundErrorResponses, conflictErrorResponses),
    }),
    sValidator("param", setupParam, invalid),
    sValidator("json", z.strictObject({ code: token }), invalid),
    async (c) => {
      const kept = done(
        await submitCode(
          c.req.valid("param").id,
          c.req.valid("json").code,
          who(c, "add the claude account from Settings by sign-in"),
        ),
      )
      return c.json({ data: { account: kept.account, confirmed: kept.confirmed } })
    },
  )
  .post(
    "/claude/open-private",
    describeRoute({
      tags: ["Settings"],
      description:
        "Open the sign-in's own link in a new window on a fresh profile of a browser this computer has, deleted when the sign-in ends: which one, or null when none opened",
      ...responses(validationErrorResponses, notFoundErrorResponses),
    }),
    sValidator("json", setupParam, invalid),
    async (c) => {
      const opened = done(await openPrivate(c.req.valid("json").id))
      return c.json({ data: { browser: opened.browser } })
    },
  )

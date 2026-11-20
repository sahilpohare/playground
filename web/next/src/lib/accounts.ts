import type { AccountRow } from "@api/hono"
import { site } from "@packages/config/site"
import { z } from "zod"

import { apiClient, unwrap } from "@/lib/api/client"

export type { AccountRow }

export type AccountProvider = AccountRow["provider"]

export const ACCOUNTS_QUERY_KEY = ["accounts"] as const

export const PROVIDER_NAMES: Record<AccountProvider, string> = { claude: "Claude", glm: "GLM" }

const LABEL = /^[a-z0-9][a-z0-9._-]*$/
const LABEL_RULE = "Lowercase letters, digits, dots, dashes and underscores"

// The Add account form: a Claude account by its email with an optional label and the code its sign-in shows, a GLM key by its label and the pasted API key.
export const accountFormSchema = z
  .object({
    email: z.string().trim(),
    label: z.string().trim(),
    provider: z.enum(["claude", "glm"]),
    token: z.string().trim().regex(/^\S*$/, "One line with no spaces"),
  })
  .superRefine((form, ctx) => {
    if (!form.token)
      ctx.addIssue({
        code: "custom",
        message:
          form.provider === "claude" ? "Paste the code the sign-in shows" : "Paste the API key",
        path: ["token"],
      })
    if (form.provider === "claude" && !z.email().safeParse(form.email).success)
      ctx.addIssue({ code: "custom", message: "An email address", path: ["email"] })
    if (form.provider === "glm" && !form.label)
      ctx.addIssue({ code: "custom", message: "A label names a GLM key", path: ["label"] })
    if (form.label && !LABEL.test(form.label))
      ctx.addIssue({ code: "custom", message: LABEL_RULE, path: ["label"] })
  })

export type AccountForm = z.input<typeof accountFormSchema>

// Pure: the body POST /api/v1/accounts takes, with only the provider's own fields.
export const accountBody = (form: AccountForm) =>
  form.provider === "glm"
    ? { label: form.label.trim(), provider: "glm" as const, token: form.token.trim() }
    : {
        email: form.email.trim(),
        ...(form.label.trim() ? { label: form.label.trim() } : {}),
        provider: "claude" as const,
        token: form.token.trim(),
      }

// A Claude sign-in as the dialog holds it: started for an email and label, with its id, its link and the browser a fresh profile opens in, or null when this computer has none or no display.
export type SignIn = {
  browser: { name: string } | null
  email: string
  id: string
  label: string
  url: string
}

// Pure: the account a Claude sign-in starts for, from the form as it is, or why it cannot start yet.
export const signInFor = (
  form: AccountForm,
): { email: string; label: string } | { refused: string } => {
  const email = form.email.trim()
  const label = form.label.trim()
  if (!z.email().safeParse(email).success)
    return { refused: "Type the email of the account to add first" }
  if (label && !LABEL.test(label)) return { refused: LABEL_RULE }
  return { email, label }
}

// Pure: whether a sign-in already started serves the form as it is now, so a changed email or label starts another.
export const signInServes = (signIn: SignIn | null, form: AccountForm): signIn is SignIn =>
  signIn !== null && signIn.email === form.email.trim() && signIn.label === form.label.trim()

// Pure: the body POST /api/v1/accounts/claude/setup takes.
export const setupBody = ({ email, label }: { email: string; label: string }) => ({
  email,
  ...(label ? { label } : {}),
})

// Pure: the open button's words: Open sign-in before a sign-in starts, then the browser it opens a new window of on a fresh profile; null once a sign-in started on a computer with no browser that takes a profile (Safari alone) or no display, where the link and Copy link are the way in.
export const openSignInLabel = (signIn: Pick<SignIn, "browser"> | null): string | null =>
  !signIn
    ? "Open sign-in"
    : signIn.browser
      ? `Open in ${signIn.browser.name} · fresh profile`
      : null

// An Add's answer as the dialog shows it: the account added, with confirmed false when a Claude sign-in's account could not be read back, or the API's own words for a refusal (no login yet, a row already listed, a token the secret store refused, a sign-in for another account), which the dialog shows in place.
export const addOutcome = async <A>(
  post: () => Promise<{
    data: { account: A; confirmed?: boolean } | null
    error: { message: string } | null
  }>,
): Promise<{ account: A; confirmed?: boolean } | { refused: string }> => {
  const { data, error } = await post()
  if (!data) return { refused: error?.message ?? "The account was not added" }
  return data.confirmed === undefined
    ? { account: data.account }
    : { account: data.account, confirmed: data.confirmed }
}

// How long the page waits on a pasted code: a little above the API's own wait (CODE_WAIT_MS in claude-setup.ts), so whenever the API answers, its words arrive first.
export const CODE_SUBMIT_MS = 80_000
// How long the page waits for a sign-in to start: a little above the API's 20s wait for setup-token's link.
export const SETUP_START_MS = 30_000

// Pure: why a pasted code was not taken, in words: the page's own wait running out, the API out of reach (as while it restarts or the link drops), or the API's own words.
export const codeFailure = (
  error: { code: string; message: string } | null,
  timedOut: boolean,
): string => {
  if (timedOut) return "Claude did not answer in time: start again for a new sign-in"
  if (!error || error.code === "NETWORK_ERROR" || error.code === "UNKNOWN_ERROR")
    return `${site.name} could not be reached, as while it restarts or the connection drops: start again`
  return error.message
}

// Pure: the toast once an account is added, saying so when its sign-in's account was not confirmed.
export const addedTitle = (key: string, confirmed?: boolean): string =>
  confirmed === false ? `${key} added, account not confirmed` : `${key} added`

// Pure: a row's title and its muted line: a Claude account by its label or email, a GLM key by its label, then its provider, its email under a label, and whether its token is kept.
export const accountWords = (row: AccountRow, login?: string | null) => ({
  description: [
    PROVIDER_NAMES[row.provider],
    row.label && row.email ? row.email : null,
    row.stored ? "Token kept" : "No token kept",
    login && row.email === login ? "Logged in" : null,
  ]
    .filter(Boolean)
    .join(" · "),
  title: row.label ?? row.email ?? row.key,
})

// GET /api/v1/accounts: every account the factory spends, whether ext init has named the login they need and the scope a write goes to, read by Settings and by the home's empty state, which asks whether a Claude one exists.
export const readAccounts = async (): Promise<{
  accounts: AccountRow[]
  login: boolean
  scope: string | null
}> => {
  const { data, error } = await unwrap(apiClient.v1.accounts.$get())
  if (error) throw new Error(error.message)
  return data
}

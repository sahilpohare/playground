"use client"

import { RiLockLine } from "@remixicon/react"
import { useForm } from "@tanstack/react-form"
import { useMutation } from "@tanstack/react-query"
import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import {
  type AccountForm,
  accountBody,
  accountFormSchema,
  addedTitle,
  addOutcome,
  CODE_SUBMIT_MS,
  codeFailure,
  openSignInLabel,
  PROVIDER_NAMES,
  type SignIn,
  SETUP_START_MS,
  setupBody,
  signInFor,
  signInServes,
} from "@/lib/accounts"
import { apiClient, unwrap } from "@/lib/api/client"

const PROVIDERS = (["claude", "glm"] as const).map((value) => ({
  label: PROVIDER_NAMES[value],
  value,
}))
const GLM_HINT =
  "Your Z.ai API key. It goes to this computer's secret store and is never shown again."

const EMPTY: AccountForm = { email: "", label: "", provider: "claude", token: "" }

// Add account: a Claude account by its sign-in's code, or a GLM key, each kept in this computer's secret store (the Keychain on a Mac); Settings > Accounts and the home's checklist open this one dialog, each with its own trigger.
export function AddAccountDialog({
  children = "Add account",
  disabled,
  onAdded,
  trigger = <Button variant="outline" size="sm" />,
}: {
  children?: React.ReactNode
  disabled?: boolean
  // the account just kept, by its email (a Claude account) or its label (a GLM key)
  onAdded: (account: { email: string | null; provider: string }) => void
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = React.useState(false)
  const [refused, setRefused] = React.useState<string | null>(null)
  const [signIn, setSignIn] = React.useState<SignIn | null>(null)
  const [linkShown, setLinkShown] = React.useState(false)
  const [starting, setStarting] = React.useState(false)
  const [again, setAgain] = React.useState(false)

  // A Claude account is added by its sign-in's code, waited on no longer than CODE_SUBMIT_MS; a code not taken ends that sign-in, so Start again opens another.
  const submitCode = async (value: AccountForm) => {
    if (!signInServes(signIn, value))
      return { refused: "Open sign-in first, then paste the code it shows" }
    const signal = AbortSignal.timeout(CODE_SUBMIT_MS)
    const outcome = await addOutcome(async () => {
      const answer = await unwrap(
        apiClient.v1.accounts.claude.setup[":id"].code.$post(
          { json: { code: value.token.trim() }, param: { id: signIn.id } },
          { init: { signal } },
        ),
      )
      return answer.data
        ? answer
        : { data: null, error: { message: codeFailure(answer.error, signal.aborted) } }
    })
    if ("refused" in outcome) {
      setSignIn(null)
      setAgain(true)
    }
    return outcome
  }

  const add = useMutation({
    mutationFn: (value: AccountForm) =>
      value.provider === "claude"
        ? submitCode(value)
        : addOutcome(() => unwrap(apiClient.v1.accounts.$post({ json: accountBody(value) }))),
    onSuccess: (outcome) => {
      if ("refused" in outcome) return setRefused(outcome.refused)
      close()
      toast.add({
        title: addedTitle(
          outcome.account.key,
          "confirmed" in outcome ? outcome.confirmed : undefined,
        ),
        type: "success",
      })
      onAdded(outcome.account)
    },
  })

  const form = useForm({
    defaultValues: EMPTY,
    onSubmit: async ({ value }) => {
      setRefused(null)
      setAgain(false)
      await add.mutateAsync(value)
    },
    validators: { onSubmit: accountFormSchema },
  })

  const close = () => {
    setOpen(false)
    form.reset()
    setRefused(null)
    setSignIn(null)
    setLinkShown(false)
    setAgain(false)
  }

  // The sign-in the form's email and label serve, started when there is none yet.
  const started = async (): Promise<SignIn | null> => {
    if (signInServes(signIn, form.state.values)) return signIn
    const wanted = signInFor(form.state.values)
    if ("refused" in wanted) {
      setRefused(wanted.refused)
      return null
    }
    const signal = AbortSignal.timeout(SETUP_START_MS)
    const { data, error } = await unwrap(
      apiClient.v1.accounts.claude.setup.$post({ json: setupBody(wanted) }, { init: { signal } }),
    )
    if (!data) {
      setRefused(
        signal.aborted
          ? "Claude did not start the sign-in in time: try again"
          : (error?.message ?? "The sign-in did not start"),
      )
      return null
    }
    const next = { ...wanted, browser: data.browser, id: data.id, url: data.url }
    setSignIn(next)
    setLinkShown(false)
    return next
  }

  const step = (run: (signIn: SignIn) => Promise<void>) => async () => {
    setRefused(null)
    setAgain(false)
    setStarting(true)
    try {
      const current = await started()
      if (current) await run(current)
    } finally {
      setStarting(false)
    }
  }

  const openPrivately = step(async (current) => {
    if (!current.browser) return setLinkShown(true)
    const { data, error } = await unwrap(
      apiClient.v1.accounts.claude["open-private"].$post({ json: { id: current.id } }),
    )
    if (!data) return setRefused(error?.message ?? "The new window did not open")
    if (!data.browser) setLinkShown(true)
  })

  // The link is shown either way, since a browser may refuse the clipboard.
  const copyLink = step(async (current) => {
    setLinkShown(true)
    const copied = await navigator.clipboard.writeText(current.url).then(
      () => true,
      () => false,
    )
    if (copied) toast.add({ title: "Link copied", type: "success" })
  })

  // A fresh sign-in after one ended: the old code goes, and the new sign-in opens as Open sign-in does.
  const startAgain = () => {
    form.setFieldValue("token", "")
    void openPrivately()
  }

  const busy = add.isPending || starting
  const checking = add.isPending && add.variables?.provider === "claude"
  const openLabel = openSignInLabel(signIn)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setOpen(true)
        else close()
      }}
    >
      <DialogTrigger disabled={disabled} render={trigger}>
        {children}
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto_auto]"
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault()
              form.handleSubmit()
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>Add an account</DialogTitle>
          <DialogDescription>Your sessions spend every account listed here.</DialogDescription>
        </DialogHeader>
        <ScrollingFields
          status={
            <SignInStatus
              checking={checking}
              onAgain={again ? startAgain : undefined}
              refused={refused}
              starting={starting}
            />
          }
        >
          <form.Field name="provider">
            {(field) => (
              <Field>
                <FieldLabel htmlFor={field.name}>Provider</FieldLabel>
                <Select
                  items={PROVIDERS}
                  value={field.state.value}
                  onValueChange={(next) => {
                    const picked = PROVIDERS.find((provider) => provider.value === next)
                    if (!picked) return
                    field.handleChange(picked.value)
                    // a Claude code is no GLM key, nor the other way round
                    form.setFieldValue("token", "")
                  }}
                  disabled={busy}
                >
                  <SelectTrigger id={field.name} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PROVIDERS.map((provider) => (
                      <SelectItem key={provider.value} value={provider.value}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            )}
          </form.Field>
          <form.Subscribe selector={(state) => state.values.provider}>
            {(provider) =>
              provider === "claude" ? (
                <>
                  <p className="text-muted-foreground text-sm">
                    Use an account other than the one this browser is signed into: the sign-in opens
                    in a new window on a fresh profile.
                  </p>
                  <form.Field name="email">
                    {(field) => (
                      <TextField
                        field={field}
                        label="Email of the account to add"
                        placeholder="you@example.com"
                        disabled={busy}
                      />
                    )}
                  </form.Field>
                  <form.Field name="label">
                    {(field) => (
                      <TextField
                        field={field}
                        label="Label (optional)"
                        placeholder="work"
                        disabled={busy}
                      />
                    )}
                  </form.Field>
                  <ol className="flex flex-col gap-4">
                    <Step n={1} title="Open sign-in">
                      <p className="text-muted-foreground text-xs">
                        It opens in a new window on a fresh profile, so the sign-in uses the new
                        account, not the one already signed in.
                      </p>
                      <div className="flex flex-wrap gap-2">
                        {openLabel && (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={openPrivately}
                            disabled={busy}
                          >
                            {openLabel}
                          </Button>
                        )}
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={copyLink}
                          disabled={busy}
                        >
                          Copy link
                        </Button>
                      </div>
                      {linkShown && signIn && (
                        <p className="text-muted-foreground text-xs break-all">
                          Open this in a browser that is not signed in to Claude: {signIn.url}
                        </p>
                      )}
                    </Step>
                    <Step
                      n={2}
                      title="Sign in with the account you want to add, and approve access"
                    />
                    <Step n={3} title="Paste the code">
                      <form.Field name="token">
                        {(field) => (
                          <TextField field={field} label="Code" type="password" disabled={busy} />
                        )}
                      </form.Field>
                    </Step>
                  </ol>
                  <p className="text-muted-foreground flex items-center gap-2 text-xs">
                    <RiLockLine className="size-3 shrink-0" />
                    The token goes to your computer&apos;s secret store. It is never shown, logged
                    or sent anywhere else.
                  </p>
                </>
              ) : (
                <>
                  <form.Field name="label">
                    {(field) => (
                      <TextField field={field} label="Label" placeholder="zai" disabled={busy} />
                    )}
                  </form.Field>
                  <form.Field name="token">
                    {(field) => (
                      <TextField
                        field={field}
                        label="API key"
                        description={GLM_HINT}
                        type="password"
                        disabled={busy}
                      />
                    )}
                  </form.Field>
                </>
              )
            }
          </form.Subscribe>
        </ScrollingFields>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button type="submit" disabled={busy}>
            Add account
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// The fields scroll in a short window while the sign-in's status stays in view, in its own row above the footer.
export function ScrollingFields({
  children,
  status,
}: {
  children: React.ReactNode
  status: React.ReactNode
}) {
  return (
    <>
      <FieldGroup className="min-h-0 overflow-y-auto">{children}</FieldGroup>
      {status}
    </>
  )
}

// What the sign-in is doing, in words: starting, checking the code, or why it stopped, with Start again once the sign-in it had has ended.
export function SignInStatus({
  checking,
  onAgain,
  refused,
  starting,
}: {
  checking: boolean
  onAgain?: () => void
  refused: string | null
  starting: boolean
}) {
  if (starting || checking)
    return (
      <p role="status" className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner />
        {starting ? "Starting the sign-in…" : "Checking the code with Claude…"}
      </p>
    )
  if (!refused) return null
  return (
    <div className="flex flex-col items-start gap-2">
      <FieldError>{refused}</FieldError>
      {onAgain && (
        <Button type="button" variant="outline" size="sm" onClick={onAgain}>
          Start again
        </Button>
      )}
    </div>
  )
}

// One step of the Claude sign-in: its number, what to do, and the controls it holds.
function Step({ children, n, title }: { children?: React.ReactNode; n: number; title: string }) {
  return (
    <li className="flex gap-3">
      <span className="text-muted-foreground flex size-5 shrink-0 items-center justify-center rounded-full border text-xs">
        {n}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </li>
  )
}

type TextFieldApi = {
  handleBlur: () => void
  handleChange: (value: string) => void
  name: string
  state: { meta: { errors: unknown[]; isTouched: boolean; isValid: boolean }; value: string }
}

function TextField({
  description,
  disabled,
  field,
  label,
  placeholder,
  type = "text",
}: {
  description?: string
  disabled: boolean
  field: TextFieldApi
  label: string
  placeholder?: string
  type?: "password" | "text"
}) {
  const isInvalid = !field.state.meta.isValid
  return (
    <Field data-invalid={isInvalid}>
      <FieldLabel htmlFor={field.name}>{label}</FieldLabel>
      <Input
        id={field.name}
        name={field.name}
        type={type}
        autoComplete="off"
        placeholder={placeholder}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(event) => field.handleChange(event.target.value)}
        aria-invalid={isInvalid}
        disabled={disabled}
      />
      {isInvalid ? (
        <FieldError errors={field.state.meta.errors as { message?: string }[]} />
      ) : (
        description && <FieldDescription>{description}</FieldDescription>
      )}
    </Field>
  )
}

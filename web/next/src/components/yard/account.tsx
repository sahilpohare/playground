"use client"

import { roleAtLeast } from "@packages/auth/access"
import { githubLoginSchema, invitePath, tokenNameSchema } from "@packages/message"
import { useForm } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import Link from "next/link"
import { useState } from "react"
import { z } from "zod"

import { PageHeader } from "@/components/shell/page-header"
import { PageShell } from "@/components/shell/page-shell"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { inviteRequests } from "@/lib/yard"
import { BOTS_KEY, INVITES_KEY, TOKENS_KEY, yardApi } from "@/lib/yard-api"

// Account and tokens: each token is a device's way to post without a browser, named for that device (never "web"), its secret shown once: with its Relay switch on it reads and posts, and the owner's holds the Mac's relay; with it off it reads alone. A member asks the owner to let someone in here, and the owner sees those requests and the bots `playground yard bot add` made.
export function Account({ role }: { role: string | null | undefined }) {
  const client = useQueryClient()
  const { data: tokens } = useQuery({
    queryFn: async () => (await yardApi.tokens()).tokens,
    queryKey: TOKENS_KEY,
  })
  const [secret, setSecret] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { name: "", relay: false },
    onSubmit: async ({ value }) => {
      try {
        const { token } = await yardApi.createToken(value.name.trim(), value.relay)
        setSecret(token.secret)
        form.reset()
        await client.invalidateQueries({ queryKey: TOKENS_KEY })
      } catch (error) {
        toast.add({ title: (error as Error).message, type: "error" })
      }
    },
    validators: { onSubmit: z.object({ name: tokenNameSchema, relay: z.boolean() }) },
  })
  const revoke = async (id: string) => {
    try {
      await yardApi.revokeToken(id)
      await client.invalidateQueries({ queryKey: TOKENS_KEY })
    } catch (error) {
      toast.add({ title: (error as Error).message, type: "error" })
    }
  }
  return (
    <PageShell size="sm">
      <PageHeader
        title="Account and tokens"
        description="Your devices' tokens, and who you let into Yard."
      />
      <div className="flex flex-col gap-6">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void form.handleSubmit()
          }}
        >
          <FieldGroup>
            <form.Field name="name">
              {(field) => {
                const isInvalid = !field.state.meta.isValid
                return (
                  <Field data-invalid={isInvalid}>
                    <FieldLabel htmlFor="token-name">New token, named for its device</FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        aria-invalid={isInvalid}
                        id="token-name"
                        name={field.name}
                        onBlur={field.handleBlur}
                        onChange={(event) => field.handleChange(event.target.value)}
                        placeholder="macbook"
                        value={field.state.value}
                      />
                      <Button disabled={!field.state.value.trim()} type="submit">
                        Create
                      </Button>
                    </div>
                    {isInvalid && <FieldError errors={field.state.meta.errors} />}
                  </Field>
                )
              }}
            </form.Field>
            <form.Field name="relay">
              {(field) => (
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    checked={field.state.value}
                    onCheckedChange={(checked) => field.handleChange(checked)}
                    size="sm"
                  />
                  {roleAtLeast(role, "owner")
                    ? "Relay: posts and connects your Mac. Off: read-only"
                    : "Relay: posts. Off: read-only"}
                </label>
              )}
            </form.Field>
          </FieldGroup>
        </form>
        {secret && (
          <div className="bg-muted rounded-md p-3 text-xs">
            <p className="mb-1 font-medium">Copy it now: it is shown this once.</p>
            <code className="break-all">{secret}</code>
          </div>
        )}
        {tokens?.length === 0 ? (
          <None>No tokens yet.</None>
        ) : (
          <ul className="divide-y rounded-md border text-sm">
            {tokens?.map((token) => (
              <li key={token.id} className="flex items-center gap-3 px-3 py-2">
                <span className="font-medium">{token.name}</span>
                <span className="text-muted-foreground text-xs">
                  {token.revokedAt
                    ? "Revoked"
                    : token.lastUsedAt
                      ? `Last used ${new Date(token.lastUsedAt).toLocaleString()}`
                      : "Never used"}
                </span>
                {!token.revokedAt && (
                  <Button
                    className="ml-auto"
                    onClick={() => void revoke(token.id)}
                    size="sm"
                    variant="outline"
                  >
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
        {roleAtLeast(role, "owner") ? (
          <>
            <Bots />
            <InviteRequests />
          </>
        ) : (
          <RequestInvite />
        )}
      </div>
    </PageShell>
  )
}

// An empty list, in the Empty primitive.
const None = ({ children }: { children: string }) => (
  <Empty className="rounded-md border p-4">
    <EmptyHeader>
      <EmptyDescription>{children}</EmptyDescription>
    </EmptyHeader>
  </Empty>
)

// The bots the owner made from the Mac, each with its log switch, which lets it read the dispatcher's log through the Mac (off until the switch turns it on, and read only while the Mac lists it too), and Revoke, which cuts its token and its DM at once.
function Bots() {
  const client = useQueryClient()
  const { data: bots } = useQuery({
    queryFn: async () => (await yardApi.bots()).bots,
    queryKey: BOTS_KEY,
  })
  const revoke = async (name: string) => {
    try {
      await yardApi.revokeBot(name)
      await client.invalidateQueries({ queryKey: BOTS_KEY })
    } catch (error) {
      toast.add({ title: (error as Error).message, type: "error" })
    }
  }
  const setReadsLog = async (name: string, readsLog: boolean) => {
    try {
      await yardApi.setReadsLog(name, readsLog)
      await client.invalidateQueries({ queryKey: BOTS_KEY })
    } catch (error) {
      toast.add({ title: (error as Error).message, type: "error" })
    }
  }
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Bots</h2>
      {bots?.length === 0 ? (
        <None>No bots yet. playground yard bot add makes one from your Mac.</None>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {bots?.map((bot) => (
            <li key={bot.name} className="flex items-center gap-3 px-3 py-2">
              <div className="flex min-w-0 flex-col sm:flex-row sm:items-center sm:gap-3">
                <span className="font-medium">{bot.login}</span>
                <span className="text-muted-foreground text-xs text-balance">
                  Made {new Date(bot.createdAt).toLocaleString()}
                </span>
              </div>
              <label className="ml-auto flex shrink-0 items-center gap-2 text-xs whitespace-nowrap">
                <Switch
                  checked={bot.readsLog}
                  onCheckedChange={(checked) => void setReadsLog(bot.name, checked)}
                  size="sm"
                />
                Reads the log
              </label>
              <Button onClick={() => void revoke(bot.name)} size="sm" variant="outline">
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Each member's request to let someone in, opening its own page to approve or deny it.
function InviteRequests() {
  const { data: requests } = useQuery({
    queryFn: async () => inviteRequests((await yardApi.invites()).invites),
    queryKey: INVITES_KEY,
  })
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Invite requests</h2>
      {requests?.length === 0 ? (
        <None>None waiting.</None>
      ) : (
        <ul className="divide-y rounded-md border text-sm">
          {requests?.map((invite) => (
            <li key={invite.id}>
              <Link className="hover:bg-muted flex px-3 py-2" href={invitePath(invite.id)}>
                {invite.requestedBy?.login ?? "A member"} asks to let {invite.forLogin ?? "someone"}{" "}
                in
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// A member asks the owner to let a GitHub login in; the request waits on the owner's approval, from this web session alone, as a token never asks.
function RequestInvite() {
  const [sent, setSent] = useState<string | null>(null)
  const form = useForm({
    defaultValues: { login: "" },
    onSubmit: async ({ value }) => {
      const login = value.login.trim()
      try {
        await yardApi.requestInvite(login)
        setSent(login)
        form.reset()
      } catch (error) {
        toast.add({ title: (error as Error).message, type: "error" })
      }
    },
    validators: { onSubmit: z.object({ login: githubLoginSchema }) },
  })
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup>
        <form.Field name="login">
          {(field) => {
            const isInvalid = !field.state.meta.isValid
            return (
              <Field data-invalid={isInvalid}>
                <FieldLabel htmlFor="invite-login">
                  Ask to let someone in, by GitHub login
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    aria-invalid={isInvalid}
                    id="invite-login"
                    name={field.name}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    placeholder="octocat"
                    value={field.state.value}
                  />
                  <Button disabled={!field.state.value.trim()} type="submit">
                    Ask
                  </Button>
                </div>
                {isInvalid && <FieldError errors={field.state.meta.errors} />}
                {sent && !isInvalid && (
                  <p className="text-muted-foreground text-xs">
                    Asked for {sent}. It waits on the owner&apos;s approval.
                  </p>
                )}
              </Field>
            )
          }}
        </form.Field>
      </FieldGroup>
    </form>
  )
}

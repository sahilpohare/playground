"use client"

import { useForm } from "@tanstack/react-form"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { ACCOUNTS_QUERY_KEY, readAccounts } from "@/lib/accounts"
import {
  readWhatsappSetting,
  saveWhatsappSetting,
  WHATSAPP_KEYS,
  whatsappFormSchema,
  whatsappQueryKey,
  whatsappWrites,
} from "@/lib/whatsapp"

const FIELDS = [
  {
    description: "The spare number WhatsApp links as a device. Never your own number.",
    label: "Device number",
    name: "device",
  },
  {
    description:
      "Your own number: the one number WhatsApp mode takes messages from and replies to.",
    label: "Your number",
    name: "owner",
  },
] as const

// The WhatsApp card's two numbers, each saved at your login's scope when you type one in, as Privacy saves its fields. A saved number comes back by its last 4 digits alone, shown as the field's placeholder, so the field starts empty and an empty field keeps what is saved.
export function WhatsappNumbers() {
  const login = useQuery({ queryKey: ACCOUNTS_QUERY_KEY, queryFn: readAccounts })
  const device = useQuery({
    queryKey: whatsappQueryKey(WHATSAPP_KEYS.device),
    queryFn: () => readWhatsappSetting(WHATSAPP_KEYS.device),
  })
  const owner = useQuery({
    queryKey: whatsappQueryKey(WHATSAPP_KEYS.owner),
    queryFn: () => readWhatsappSetting(WHATSAPP_KEYS.owner),
  })
  const scope = login.data?.scope
  if (!scope || !device.isSuccess || !owner.isSuccess) return null
  return <WhatsappForm saved={{ device: device.data, owner: owner.data }} scope={scope} />
}

function WhatsappForm({
  saved,
  scope,
}: {
  saved: { device: string; owner: string }
  scope: string
}) {
  const queryClient = useQueryClient()
  const form = useForm({
    defaultValues: { device: "", owner: "" },
    onSubmit: async ({ value, formApi }) => {
      const writes = whatsappWrites(value)
      try {
        for (const field of writes) await saveWhatsappSetting(field.key, field.value, scope)
        toast.add({
          title: writes.length ? "WhatsApp numbers saved" : "Nothing to save",
          type: "success",
        })
        formApi.reset()
      } catch (error) {
        toast.add({ title: (error as Error).message, type: "error" })
      } finally {
        for (const field of writes)
          await queryClient.invalidateQueries({ queryKey: whatsappQueryKey(field.key) })
      }
    },
    validators: { onSubmit: whatsappFormSchema },
  })
  return (
    <form
      className="pt-2"
      onSubmit={(event) => {
        event.preventDefault()
        form.handleSubmit()
      }}
    >
      <FieldGroup className="gap-3">
        {FIELDS.map((entry) => (
          <form.Field key={entry.name} name={entry.name}>
            {(field) => {
              const isInvalid = !field.state.meta.isValid
              const id = `whatsapp-${entry.name}`
              return (
                <Field data-invalid={isInvalid} className="gap-1.5">
                  <FieldLabel htmlFor={id} className="text-xs">
                    {entry.label}
                  </FieldLabel>
                  <Input
                    id={id}
                    name={id}
                    autoComplete="off"
                    inputMode="tel"
                    placeholder={saved[entry.name] || "+15550100001"}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    aria-invalid={isInvalid}
                  />
                  {isInvalid ? (
                    <FieldError errors={field.state.meta.errors as { message?: string }[]} />
                  ) : (
                    <FieldDescription className="text-xs">
                      {entry.description}
                      {saved[entry.name] && ` Saved as ${saved[entry.name]}.`}
                    </FieldDescription>
                  )}
                </Field>
              )
            }}
          </form.Field>
        ))}
        <form.Subscribe selector={(state) => state.isSubmitting}>
          {(submitting) => (
            <Field orientation="horizontal">
              <Button type="submit" size="sm" disabled={submitting}>
                {submitting && <Spinner />}
                Save
              </Button>
            </Field>
          )}
        </form.Subscribe>
      </FieldGroup>
    </form>
  )
}

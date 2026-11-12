"use client"

import { SESSION_MODELS } from "@packages/config/console"
import { RiAddLine, RiArrowGoBackLine, RiDeleteBinLine, RiPencilLine } from "@remixicon/react"
import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import * as React from "react"

import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { readLiveChecks } from "@/components/first-run/checks"
import { Hint } from "@/components/hint"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toast } from "@/components/ui/toast"
import { ACCOUNTS_QUERY_KEY, readAccounts } from "@/lib/accounts"
import { LIVE_CHECKS_QUERY_KEY } from "@/lib/onboard"
import { EFFORT_LABELS, MODEL_LABELS } from "@/lib/session-setting"
import {
  kindWord,
  newDefaults,
  newTemplateId,
  readTemplateSetting,
  resetTemplate,
  type Template,
  TEMPLATE_KINDS,
  TEMPLATE_SETTING_QUERY_KEY,
  TEMPLATE_STATE_WORDS,
  type TemplateField,
  type TemplateForm,
  templateForm,
  templateOf,
  templateRefusal,
  TEMPLATES_QUERY_KEY,
  type TemplateState,
  templateState,
  templateWords,
  withoutTemplate,
  withTemplate,
  writeTemplates,
} from "@/lib/templates"

type Option = { label: string; value: string }

const DEFAULT: Option = { label: "Default", value: "" }
// Claude Code's backends, as packages/settings' HARNESSES lists them; a test keeps the two equal.
export const BACKENDS: Option[] = [
  { label: "Claude", value: "claude" },
  { label: "GLM", value: "glm" },
]
const KINDS: Option[] = TEMPLATE_KINDS.map((kind) => ({ label: kindWord(kind), value: kind }))
const EFFORTS: Option[] = [
  DEFAULT,
  ...Object.entries(EFFORT_LABELS).map(([value, label]) => ({ label, value })),
]

// A list's options with a stored value it does not name kept, so the field shows what is saved.
const withStored = (options: Option[], stored: string): Option[] =>
  !stored || options.some((option) => option.value === stored)
    ? options
    : [...options, { label: stored, value: stored }]

type Pending = { action: "remove" | "reset"; template: Template }

// Settings > Templates: the templates the sidebar's plus starts a session from, each a default, an edited default or one you added, with Edit, Reset on an edited default and Remove on an added one, a default Playground added after the list was saved as a new default with Add, and Add template; every save goes through the settings write path, whose schema refuses a bad value at its field. The picker's Edit templates lands here, at #templates.
export function Templates() {
  const queryClient = useQueryClient()
  const setting = useQuery({ queryKey: TEMPLATE_SETTING_QUERY_KEY, queryFn: readTemplateSetting })
  const accounts = useQuery({ queryKey: ACCOUNTS_QUERY_KEY, queryFn: readAccounts })
  const scope = accounts.data?.scope ?? null
  const [editing, setEditing] = React.useState<{ template?: Template } | null>(null)
  const [pending, setPending] = React.useState<Pending | null>(null)
  const shown = React.useRef<Pending | null>(null)
  if (pending) shown.current = pending
  const section = React.useRef<HTMLElement>(null)
  const landed = React.useRef(false)
  const checks = useQuery({ queryKey: LIVE_CHECKS_QUERY_KEY, queryFn: readLiveChecks })
  const settled = !setting.isPending && !accounts.isPending && !checks.isPending

  // This Mac's checks and Accounts above draw from the same reads, so once all three settle the section stays where the scroll puts it.
  React.useEffect(() => {
    if (!settled || landed.current) return
    landed.current = true
    if (window.location.hash === "#templates") section.current?.scrollIntoView()
  }, [settled])

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: TEMPLATE_SETTING_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: TEMPLATES_QUERY_KEY }),
    ])

  const change = useMutation({
    mutationFn: async ({ action, template }: Pending) => {
      const { defaults, rows } = setting.data!
      const next =
        action === "reset"
          ? resetTemplate(rows, template.id, defaults)
          : withoutTemplate(rows, template.id, defaults)
      const verb = action === "reset" ? "Reset" : "Removed"
      await writeTemplates(
        next,
        { defaults, read: rows },
        {
          reason: `${verb} the ${template.label} template in Settings`,
          scope: scope!,
        },
      )
      return `${template.label} ${action === "reset" ? "reset" : "removed"}`
    },
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    onSuccess: (title) => {
      setPending(null)
      toast.add({ title, type: "success" })
      void refresh()
    },
  })

  // A click on a new default's Add is the confirmation, so it writes at once.
  const add = useMutation({
    mutationFn: async (template: Template) => {
      const { defaults, rows } = setting.data!
      await writeTemplates(
        withTemplate(rows, template),
        { defaults, read: rows },
        { reason: `Added the default ${template.label} template in Settings`, scope: scope! },
      )
      return `${template.label} added`
    },
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    // Add stays pending until the list is read again, so a second quick Add writes over the list with the first in it.
    onSuccess: (title) => {
      toast.add({ title, type: "success" })
      return refresh()
    },
  })

  const rows = setting.data?.rows
  const defaults = setting.data?.defaults ?? []
  const entries: { state: TemplateState; template: Template }[] = rows
    ? [
        ...rows.map((template) => ({ state: templateState(template, defaults), template })),
        ...newDefaults(rows, defaults).map((template) => ({ state: "new" as const, template })),
      ].sort((a, b) => a.template.label.localeCompare(b.template.label))
    : []
  const writable = Boolean(scope && setting.data)
  const confirm = shown.current
  return (
    <section
      ref={section}
      id="templates"
      aria-labelledby="settings-templates"
      className="flex scroll-mt-4 flex-col gap-2"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="settings-templates" className="text-muted-foreground text-sm font-medium">
          Templates
        </h2>
        <Button variant="outline" size="sm" disabled={!writable} onClick={() => setEditing({})}>
          Add template
        </Button>
      </div>
      {setting.isPending ? (
        <div aria-busy="true" className="h-14" />
      ) : setting.error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Templates could not be read</EmptyTitle>
            <EmptyDescription>{setting.error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : entries.length ? (
        <ItemGroup className="gap-2">
          {entries.map(({ state, template }) => (
            <Item key={template.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>{template.label}</ItemTitle>
                <ItemDescription>
                  {[TEMPLATE_STATE_WORDS[state], templateWords(template)].join(" · ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                {state === "edited" && (
                  <Hint content="Reset to default">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Reset ${template.label}`}
                      disabled={!writable}
                      onClick={() => setPending({ action: "reset", template })}
                    >
                      <RiArrowGoBackLine />
                    </Button>
                  </Hint>
                )}
                {state === "new" ? (
                  <Hint content="Add to your templates">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Add ${template.label}`}
                      disabled={!writable || add.isPending}
                      onClick={() => add.mutate(template)}
                    >
                      <RiAddLine />
                    </Button>
                  </Hint>
                ) : (
                  <Hint content="Edit">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Edit ${template.label}`}
                      disabled={!writable}
                      onClick={() => setEditing({ template })}
                    >
                      <RiPencilLine />
                    </Button>
                  </Hint>
                )}
                {state === "added" && (
                  <Hint content="Remove">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Remove ${template.label}`}
                      disabled={!writable}
                      onClick={() => setPending({ action: "remove", template })}
                    >
                      <RiDeleteBinLine />
                    </Button>
                  </Hint>
                )}
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No templates</EmptyTitle>
            <EmptyDescription>Add one to start a session from the sidebar.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
      {editing && setting.data && scope && (
        <TemplateDialog
          accounts={(accounts.data?.accounts ?? [])
            .filter((row) => row.provider === "claude")
            .map((row) => row.key)}
          defaults={defaults}
          onClose={() => setEditing(null)}
          onSaved={refresh}
          rows={setting.data.rows}
          scope={scope}
          template={editing.template}
        />
      )}
      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
        title={
          confirm?.action === "reset"
            ? `Reset ${confirm.template.label}?`
            : `Remove ${confirm?.template.label ?? ""}?`
        }
        description={
          confirm?.action === "reset"
            ? "Its edits go, and the default's values come back."
            : "It leaves the sidebar's list of templates."
        }
        action={confirm?.action === "reset" ? "Reset" : "Remove"}
        variant={confirm?.action === "reset" ? "default" : "destructive"}
        pending={change.isPending}
        onConfirm={() => {
          if (pending) change.mutate(pending)
        }}
      />
    </section>
  )
}

// Edit or Add template: the fields the schema checks, a refused save's reason beside its field.
function TemplateDialog({
  accounts,
  defaults,
  onClose,
  onSaved,
  rows,
  scope,
  template,
}: {
  accounts: string[]
  defaults: Template[]
  onClose: () => void
  onSaved: () => void
  rows: Template[]
  scope: string
  template?: Template
}) {
  const [refusal, setRefusal] = React.useState<ReturnType<typeof templateRefusal> | null>(null)
  const fields = React.useRef<HTMLDivElement>(null)

  // A refusal can sit under a field below the scrolled fields' fold, so the first one scrolls into view.
  React.useEffect(() => {
    if (refusal)
      fields.current?.querySelector('[role="alert"]')?.scrollIntoView({ block: "nearest" })
  }, [refusal])

  const save = useMutation({
    mutationFn: async (
      form: TemplateForm,
    ): Promise<{ refused: ReturnType<typeof templateRefusal> } | { saved: Template }> => {
      const saved = templateOf(form, template?.id ?? newTemplateId(form.label, rows))
      const next = withTemplate(rows, saved)
      try {
        await writeTemplates(
          next,
          { defaults, read: rows },
          {
            reason: `${template ? "Edited" : "Added"} the ${saved.label} template in Settings`,
            scope,
          },
        )
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { refused: templateRefusal(message, next.indexOf(saved)) }
      }
      return { saved }
    },
    onSuccess: (outcome) => {
      if ("refused" in outcome) return setRefusal(outcome.refused)
      toast.add({ title: `${outcome.saved.label} saved`, type: "success" })
      onSaved()
      onClose()
    },
  })

  const form = useForm({
    defaultValues: templateForm(template),
    onSubmit: async ({ value }) => {
      setRefusal(null)
      await save.mutateAsync(value)
    },
  })

  const busy = save.isPending
  const isDefault = Boolean(template && defaults.some((row) => row.id === template.id))
  const error = (name: TemplateField) => refusal?.fields[name]
  const select = (name: TemplateField, label: string, options: Option[]) => (
    <form.Field name={name}>
      {(field) => {
        const items = withStored(options, field.state.value)
        return (
          <Field data-invalid={Boolean(error(name))}>
            <FieldLabel htmlFor={`template-${name}`}>{label}</FieldLabel>
            <Select
              items={items}
              value={field.state.value}
              onValueChange={(next) => field.handleChange((next as string | null) ?? "")}
              disabled={busy}
            >
              <SelectTrigger
                id={`template-${name}`}
                className="w-full"
                aria-invalid={Boolean(error(name))}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error(name) && <FieldError>{error(name)}</FieldError>}
          </Field>
        )
      }}
    </form.Field>
  )
  const text = (name: "brief" | "label", label: string, description: string) => (
    <form.Field name={name}>
      {(field) => (
        <Field data-invalid={Boolean(error(name))}>
          <FieldLabel htmlFor={`template-${name}`}>{label}</FieldLabel>
          <Input
            id={`template-${name}`}
            autoComplete="off"
            value={field.state.value}
            onChange={(event) => field.handleChange(event.target.value)}
            aria-invalid={Boolean(error(name))}
            disabled={busy || (name === "label" && isDefault)}
          />
          {error(name) ? (
            <FieldError>{error(name)}</FieldError>
          ) : (
            <FieldDescription>{description}</FieldDescription>
          )}
        </Field>
      )}
    </form.Field>
  )

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[calc(100svh-2rem)] grid-rows-[auto_minmax(0,1fr)_auto_auto]"
        render={
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void form.handleSubmit()
            }}
          />
        }
      >
        <DialogHeader>
          <DialogTitle>{template ? `Edit ${template.label}` : "Add a template"}</DialogTitle>
          <DialogDescription>
            {isDefault
              ? "A default: your edits save over it, and Reset brings it back."
              : "The sidebar's plus starts a session from it."}{" "}
            A default Playground adds later shows in the list as New default, and Add puts it in.
          </DialogDescription>
        </DialogHeader>
        <FieldGroup ref={fields} className="min-h-0 overflow-y-auto">
          {text(
            "label",
            "Label",
            isDefault ? "A default keeps its name." : "The name the sidebar's list shows.",
          )}
          {select("kind", "Kind", KINDS)}
          {select("backend", "Backend", BACKENDS)}
          <form.Subscribe selector={(state) => state.values.backend}>
            {(backend) =>
              backend === "claude" && (
                <>
                  {select("model", "Model", [
                    DEFAULT,
                    ...SESSION_MODELS.map((value) => ({ label: MODEL_LABELS[value], value })),
                  ])}
                  {select("effort", "Effort", EFFORTS)}
                  {select("account", "Account", [
                    DEFAULT,
                    ...accounts.map((email) => ({ label: email, value: email })),
                  ])}
                </>
              )
            }
          </form.Subscribe>
          {text("brief", "Brief", "A file name in the data folder or scripts/briefs.")}
        </FieldGroup>
        {refusal?.rest && <FieldError>{refusal.rest}</FieldError>}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" type="button" />}>Cancel</DialogClose>
          <Button type="submit" disabled={busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

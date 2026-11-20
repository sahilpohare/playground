"use client"

import { useForm } from "@tanstack/react-form"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { cn } from "cn"

import { SetUpSettings } from "@/components/settings/set-up-settings"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { ACCOUNTS_QUERY_KEY, readAccounts } from "@/lib/accounts"
import {
  JOBS_QUERY_KEY,
  type JobRow,
  parseJobConfig,
  readJobs,
  RESTORE_JOB,
  restoreCheckout,
  saveJobConfig,
  saveJobToggle,
} from "@/lib/jobs"
import { useOps, whenWords } from "@/lib/ops"

// Settings > Jobs: each ops job Playground ships and each org's own job, what it does, when it runs and whether it is on, and a switch that turns it on or off at its scope (your login's, or an org's for its own job), its enabled field alone, for a job with a config that config with the job's last refusal of it and an edit that saves it at once, and on ops-restore's row Restore now. Before the settings are set up it shows Set up settings, as Privacy does.
export function Jobs() {
  const login = useQuery({ queryKey: ACCOUNTS_QUERY_KEY, queryFn: readAccounts })
  const scope = login.data?.scope
  const jobs = useQuery({
    enabled: Boolean(scope),
    queryFn: () => readJobs(scope!),
    queryKey: JOBS_QUERY_KEY,
  })
  const error = login.error ?? jobs.error
  return (
    <section aria-labelledby="settings-jobs" className="flex flex-col gap-2">
      <h2 id="settings-jobs" className="text-muted-foreground text-sm font-medium">
        Jobs
      </h2>
      {login.data?.login === false ? (
        <SetUpSettings />
      ) : error ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>Jobs could not be read</EmptyTitle>
            <EmptyDescription>{error.message}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : scope && jobs.data ? (
        <JobList jobs={jobs.data} scope={scope} />
      ) : (
        <div aria-busy="true" className="h-14" />
      )}
    </section>
  )
}

function JobList({ jobs, scope }: { jobs: JobRow[]; scope: string }) {
  const queryClient = useQueryClient()
  const ops = useOps(true)
  const refusedOf = (job: JobRow) => ops.data?.find((row) => row.job === job.name)?.configRefused
  const toggle = useMutation({
    mutationFn: ({ job, on }: { job: JobRow; on: boolean }) => saveJobToggle(job, on),
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY }),
    onSuccess: (_, { job, on }) =>
      toast.add({ title: `${job.name} turned ${on ? "on" : "off"}`, type: "success" }),
  })
  return (
    <>
      <p className="text-muted-foreground text-xs">
        A switch saves whether the job runs, nothing else, and the runner starts or stops it on its
        next pass.
      </p>
      <ItemGroup className="gap-2">
        {jobs.map((job) => (
          <Item
            key={`${job.key} ${job.scope}`}
            role="listitem"
            size="sm"
            variant="outline"
            className="items-start"
          >
            <ItemContent className="min-w-0 gap-1.5 py-1 text-xs">
              <ItemTitle className="font-mono">{job.name}</ItemTitle>
              <ItemDescription className="text-xs">{job.description}</ItemDescription>
              <p className="text-muted-foreground text-2xs">
                {[
                  job.schedule ? (whenWords(job.schedule) ?? "") : "",
                  !job.set
                    ? "default"
                    : job.scope === scope
                      ? "set in your settings"
                      : `set in ${job.scope}'s settings`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </p>
              {job.name === RESTORE_JOB && <RestoreNow />}
              {job.config && (
                <JobConfig
                  key={JSON.stringify(job.config)}
                  config={job.config}
                  job={job}
                  refused={refusedOf(job)}
                />
              )}
            </ItemContent>
            <ItemActions>
              <Switch
                aria-label={`${job.name} on`}
                checked={job.enabled}
                disabled={toggle.isPending}
                onCheckedChange={(on) => toggle.mutate({ job, on })}
                size="sm"
              />
            </ItemActions>
          </Item>
        ))}
      </ItemGroup>
    </>
  )
}

// Restore now on ops-restore's row: the restore's steps run at once for a main checkout whose guards are gone, with the job on or off, and what it restored, or why it could not, under the button.
function RestoreNow() {
  const restore = useMutation({ mutationFn: restoreCheckout })
  const failed = Boolean(restore.error) || restore.data?.status === "stopped"
  return (
    <div className="mt-1 flex flex-col items-start gap-1.5">
      <Button
        disabled={restore.isPending}
        onClick={() => restore.mutate()}
        size="sm"
        variant="outline"
      >
        {restore.isPending && <Spinner />}
        Restore now
      </Button>
      {(restore.error || restore.data) && (
        <p
          role="status"
          className={cn("text-xs", failed ? "text-destructive" : "text-muted-foreground")}
        >
          {restore.error?.message ?? restore.data?.text}
        </p>
      )}
    </div>
  )
}

// A job's config card: its config as JSON in a box you edit, the job's last refusal of it from its heartbeat, and Save, which writes the object at the job's scope at once, since the click is already yours.
function JobConfig({
  config,
  job,
  refused,
}: {
  config: Record<string, unknown>
  job: JobRow
  refused: string | undefined
}) {
  const queryClient = useQueryClient()
  const shown = JSON.stringify(config, null, 2)
  const save = useMutation({
    mutationFn: (next: Record<string, unknown>) => saveJobConfig(job, next),
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: JOBS_QUERY_KEY }),
    onSuccess: () => toast.add({ title: `${job.name}'s config saved`, type: "success" }),
  })
  const form = useForm({
    defaultValues: { text: shown },
    onSubmit: async ({ value }) => {
      const parsed = parseJobConfig(value.text)
      if ("config" in parsed) await save.mutateAsync(parsed.config)
    },
  })
  const id = `job-config-${job.name}-${job.scope}`
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        void form.handleSubmit()
      }}
    >
      <FieldGroup className="mt-1 gap-2">
        <form.Field
          name="text"
          validators={{
            onChange: ({ value }) => {
              const parsed = parseJobConfig(value)
              return "error" in parsed ? parsed.error : undefined
            },
          }}
        >
          {(field) => {
            const error = field.state.meta.errors[0]
            return (
              <>
                <Field data-invalid={Boolean(error)}>
                  <FieldLabel htmlFor={id} className="text-xs">
                    Config
                  </FieldLabel>
                  <Textarea
                    aria-invalid={Boolean(error)}
                    className="font-mono text-xs md:text-xs"
                    disabled={save.isPending}
                    id={id}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                    spellCheck={false}
                    value={field.state.value}
                  />
                  {error && <FieldError>{String(error)}</FieldError>}
                  {refused && (
                    <FieldDescription className="text-destructive text-xs">
                      The job refused its config: {refused}
                    </FieldDescription>
                  )}
                </Field>
                <div>
                  <Button
                    disabled={save.isPending || Boolean(error) || field.state.value === shown}
                    size="sm"
                    type="submit"
                    variant="outline"
                  >
                    Save
                  </Button>
                </div>
              </>
            )
          }}
        </form.Field>
      </FieldGroup>
    </form>
  )
}

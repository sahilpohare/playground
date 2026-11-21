"use client"
"use no memo"

import type { SystemAgent, SystemPoint, SystemReport, SystemStack } from "@api/hono"
import type { ColumnDef } from "@tanstack/react-table"
import { Area, AreaChart, YAxis } from "recharts"

import { AgentLink } from "@/components/dashboard/agent-link"
import {
  DataTable,
  DataTableCellText,
  DataTableColumnHeader,
  useStaticTable,
  type ColumnConfig,
  type Features,
} from "@/components/data-table"
import { Hint } from "@/components/hint"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"
import { Spinner } from "@/components/ui/spinner"
import { useNow } from "@/lib/dashboard"
import {
  byWeekReset,
  checkoutLabel,
  clusterOf,
  isStale,
  joinedLine,
  PRESSURE_LABELS,
  sizeLabel,
  usageLine,
  useSystem,
} from "@/lib/system"
import { relativeTime } from "@/lib/time"

const GB = 1024 ** 3

// One series in the chart ramp's middle step: a single hue, so the title names it and no legend is needed.
const sparkConfig = (label: string): ChartConfig => ({ value: { color: "var(--chart-2)", label } })

const timeOf = (at: unknown): string =>
  typeof at === "string"
    ? new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : ""

// The last hour of one total, with its value and time on hover.
function Sparkline({
  label,
  max,
  points,
}: {
  label: string
  max?: number
  points: { at: string; value: number | null }[]
}) {
  if (points.length < 2) {
    return <span className="text-muted-foreground">Filling in</span>
  }
  return (
    <ChartContainer
      config={sparkConfig(label)}
      className="aspect-auto h-6 w-full"
      role="img"
      aria-label={`${label} over the last hour`}
    >
      <AreaChart data={points} margin={{ bottom: 0, left: 0, right: 0, top: 4 }}>
        <YAxis hide domain={[0, max ?? "auto"]} />
        <ChartTooltip
          content={
            <ChartTooltipContent
              indicator="line"
              labelFormatter={(_, payload) => timeOf(payload?.[0]?.payload?.at)}
            />
          }
        />
        <Area
          connectNulls
          dataKey="value"
          fill="var(--color-value)"
          fillOpacity={0.1}
          isAnimationActive={false}
          stroke="var(--color-value)"
          strokeWidth={2}
          type="monotone"
        />
      </AreaChart>
    </ChartContainer>
  )
}

const series = (history: SystemPoint[], pick: (p: SystemPoint) => number | null) =>
  history.map((point) => ({ at: point.at, value: pick(point) }))

const toGb = (bytes: number | null): number | null =>
  bytes === null ? null : Math.round((bytes / GB) * 10) / 10

// One reading: what it is, its value now with its split by machine on hover in a cluster and, while a machine does not read, its marker under it, what qualifies it, and its last hour where one is kept.
type Reading = {
  detail: string
  hour: React.ReactNode
  hover?: string
  id: string
  label: string
  marker?: string | null
  value: string
}

// Pure: what qualifies the swap reading: macOS grows swap as it needs it, while Linux keeps it at the size its swap partition or file was given.
export const swapDetail = (platform: string): string =>
  platform === "linux" ? "Linux keeps swap at a set size" : "macOS grows swap as it needs it"

// Pure: the readings table's rows, each summed over the cluster with its split on hover once report.machines names peers, else this machine's own, which memory, CPU and swap say in their detail; Docker is always this machine's.
export function readingsOf(report: SystemReport, now: Date): Reading[] {
  const { cpu, disk, docker, history, memory } = report
  const swap = memory.swap
  const containersBytes = docker.containers.reduce((sum, c) => sum + (c.bytes ?? 0), 0)
  const cluster = clusterOf(report.machines, memory.pressure, now)
  const alone = cluster ? "" : " · This machine only"
  const maxBytes = cluster
    ? report.machines.reduce((sum, m) => sum + (m.reading?.memory.totalBytes ?? 0), 0)
    : memory.totalBytes
  return [
    {
      detail:
        cluster?.memory.detail ??
        `${memory.freePercent === null ? "Free share unknown" : `${memory.freePercent}% free`} · pressure ${memory.pressure ? PRESSURE_LABELS[memory.pressure] : "unknown"}${alone}`,
      hour: (
        <Sparkline
          label="RAM used, GB"
          max={toGb(maxBytes) ?? undefined}
          points={series(history, (p) => toGb(p.usedBytes))}
        />
      ),
      hover: cluster?.memory.hover,
      id: "memory",
      label: "Memory",
      marker: cluster?.memory.marker,
      value:
        cluster?.memory.value ??
        `${sizeLabel(memory.usedBytes)} of ${sizeLabel(memory.totalBytes)}`,
    },
    {
      detail: cluster?.cpu.detail ?? `1, 5 and 15 min.: ${cpu.load.join(" / ")}${alone}`,
      hour: <Sparkline label="Load, 1 min." points={series(history, (p) => p.load1)} />,
      hover: cluster?.cpu.hover,
      id: "cpu",
      label: "CPU load",
      marker: cluster?.cpu.marker,
      value: cluster?.cpu.value ?? `${cpu.load[0]} on ${cpu.cores} cores`,
    },
    {
      detail: `${swapDetail(report.platform)}${alone}`,
      hour: (
        <Sparkline label="Swap used, GB" points={series(history, (p) => toGb(p.swapUsedBytes))} />
      ),
      hover: cluster?.swap.hover,
      id: "swap",
      label: "Swap",
      marker: cluster?.swap.marker,
      value:
        cluster?.swap.value ??
        (swap ? `${sizeLabel(swap.usedBytes)} of ${sizeLabel(swap.totalBytes)}` : "-"),
    },
    {
      detail:
        cluster?.disk.detail ?? (disk ? `of ${sizeLabel(disk.totalBytes)}` : "Could not be read"),
      hour: null,
      hover: cluster?.disk.hover,
      id: "disk",
      label: "Disk free",
      marker: cluster?.disk.marker,
      value: cluster?.disk.value ?? (disk ? sizeLabel(disk.freeBytes) : "-"),
    },
    {
      detail:
        docker.problem ??
        `The process serving Docker's socket; ${docker.containers.length} containers use ${sizeLabel(containersBytes)} of it`,
      hour: null,
      id: "docker",
      label: "Docker",
      value: sizeLabel(docker.vmBytes),
    },
  ]
}

const readingsConfig: Record<string, ColumnConfig> = {
  label: { extra: 12 },
  value: { extra: 24, wrap: true },
  detail: { extra: 36, flex: true, wrap: true },
  hour: { width: 36 },
}

const readingsColumns: ColumnDef<Features, Reading, unknown>[] = [
  {
    accessorKey: "label",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column}>{row.original.label}</DataTableCellText>
    ),
    enableSorting: false,
    meta: { label: "Reading" },
  },
  {
    accessorKey: "value",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column} className="tabular-nums">
        {row.original.hover ? (
          <Hint content={row.original.hover}>
            <span>
              <span className="block">{row.original.value}</span>
              {row.original.marker && (
                <span className="text-muted-foreground block">{row.original.marker}</span>
              )}
            </span>
          </Hint>
        ) : (
          row.original.value
        )}
      </DataTableCellText>
    ),
    enableSorting: false,
    meta: { label: "Now" },
  },
  {
    accessorKey: "detail",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column} className="text-muted-foreground">
        {row.original.detail}
      </DataTableCellText>
    ),
    enableSorting: false,
    meta: { label: "Detail" },
  },
  {
    id: "hour",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ row }) => <div className="w-full">{row.original.hour}</div>,
    enableSorting: false,
    meta: { label: "Last hour" },
  },
]

// The machine's totals, or the cluster's, one plain row each, with the last hour as a small sparkline.
function Readings({ now, report }: { now: Date; report: SystemReport }) {
  const table = useStaticTable({
    columnConfig: readingsConfig,
    columns: readingsColumns,
    data: readingsOf(report, now),
    getRowId: (row) => row.id,
  })
  return <DataTable aria-label="Readings" size="sm" table={table} />
}

const stackLine = (stack: SystemStack, now: Date): string =>
  [
    checkoutLabel(stack.checkout),
    sizeLabel(stack.bytes),
    ...stack.containers.map((c) => `${c.name} ${sizeLabel(c.bytes)}`),
    stack.idleSince ? `idle since ${relativeTime(stack.idleSince, now)}` : null,
  ]
    .filter(Boolean)
    .join(" · ")

// One footprint row: a live session, or what runs in a checkout with no session.
type Footprint = {
  bytes: number | null
  claudeBytes: number | null
  cpuPercent: number
  id: string
  session: Pick<SystemAgent, "name" | "sessionId"> | null
  stacks: SystemStack[]
}

const footprintConfig: Record<string, ColumnConfig> = {
  agent: { extra: 36 },
  memory: { align: "right" },
  claude: { align: "right" },
  stack: { extra: 48, flex: true, wrap: true },
  cpu: { align: "right" },
}

const footprintColumns = (now: Date): ColumnDef<Features, Footprint, unknown>[] => [
  {
    id: "agent",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ row }) =>
      row.original.session ? (
        <AgentLink
          name={row.original.session.name}
          sessionId={row.original.session.sessionId}
          truncate
        />
      ) : (
        <span className="text-muted-foreground">No session</span>
      ),
    enableSorting: false,
    meta: { label: "Agent" },
  },
  {
    accessorFn: (row) => row.bytes ?? 0,
    id: "memory",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column} className="tabular-nums">
        {sizeLabel(row.original.bytes)}
      </DataTableCellText>
    ),
    meta: { label: "Memory" },
  },
  {
    accessorFn: (row) => row.claudeBytes ?? 0,
    id: "claude",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column} className="tabular-nums">
        {row.original.session ? sizeLabel(row.original.claudeBytes) : "-"}
      </DataTableCellText>
    ),
    meta: { label: "Claude" },
  },
  {
    id: "stack",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column}>
        {row.original.stacks.length === 0 ? (
          <span className="text-muted-foreground">-</span>
        ) : (
          row.original.stacks.map((stack) => (
            <Hint key={stack.checkout} content={stack.checkout}>
              <span className="block">{stackLine(stack, now)}</span>
            </Hint>
          ))
        )}
      </DataTableCellText>
    ),
    enableSorting: false,
    meta: { label: "Dev stack" },
  },
  {
    accessorKey: "cpuPercent",
    id: "cpu",
    header: ({ column }) => <DataTableColumnHeader column={column} />,
    cell: ({ column, row }) => (
      <DataTableCellText column={column} className="tabular-nums">
        {Math.round(row.original.cpuPercent)}%
      </DataTableCellText>
    ),
    meta: { label: "CPU" },
  },
]

// Each live session's footprint, heaviest first, then what runs in a checkout with no session.
function Footprints({ now, report }: { now: Date; report: SystemReport }) {
  const rows: Footprint[] = [
    ...report.agents.map((agent) => ({
      bytes: agent.bytes,
      claudeBytes: agent.claudeBytes,
      cpuPercent: agent.cpuPercent,
      id: agent.sessionId,
      session: agent,
      stacks: agent.stacks,
    })),
    ...report.detached.map((stack) => ({
      bytes: stack.bytes,
      claudeBytes: null,
      cpuPercent: stack.cpuPercent,
      id: `detached:${stack.checkout}`,
      session: null,
      stacks: [stack],
    })),
  ]
  const table = useStaticTable({
    columnConfig: footprintConfig,
    columns: footprintColumns(now),
    data: rows,
    getRowId: (row) => row.id,
  })
  return <DataTable aria-label="Each agent's footprint" size="sm" table={table} />
}

// The machine's room for more workers, for the owner and for the leads before they spawn: the capacity line, what stopping idle stacks would free, the usage windows, the totals with their last hour, and each agent's footprint. Read from GET /api/v1/system, sampled every 30s.
export function SystemPanel() {
  const { data: report, error, isPending, refetch } = useSystem()
  const nowMs = useNow()
  const now = new Date(nowMs)
  return (
    <section aria-labelledby="system" className="flex flex-col gap-2">
      <div>
        <h2 id="system" className="text-muted-foreground text-sm font-medium">
          System
          {report && (
            <span className="font-normal"> · sampled {relativeTime(report.sampledAt, now)}</span>
          )}
        </h2>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>The system could not be read</AlertTitle>
          <AlertDescription>
            {error.message}{" "}
            <button type="button" className="underline" onClick={() => void refetch()}>
              Try again
            </button>
          </AlertDescription>
        </Alert>
      )}
      {isPending && !error && <Spinner />}
      {report && isStale(report.sampledAt, nowMs) && (
        <Alert variant="destructive">
          <AlertTitle>Sampling has stopped</AlertTitle>
          <AlertDescription>
            The last sample is from {relativeTime(report.sampledAt, now)}, so these numbers are no
            longer this machine&apos;s. Restart the API to start it again.
          </AlertDescription>
        </Alert>
      )}
      {report && (
        <>
          <div className="flex flex-col gap-1 text-sm">
            <p>{report.capacity.line}</p>
            <p className="text-muted-foreground">
              {report.capacity.idle.line
                ? `${report.capacity.idle.line}: ${report.capacity.idle.stacks
                    .map(
                      (stack) => `${stack.name ?? "no session"} (${checkoutLabel(stack.checkout)})`,
                    )
                    .join(", ")}`
                : report.capacity.idle.ready
                  ? "No worker's dev stack has idled 15 minutes"
                  : "Idle dev stacks show once the panel has watched for 15 minutes"}
            </p>
            {report.accounts.length < 2 ? (
              <p className="text-muted-foreground">Usage: {usageLine(report.usage, nowMs)}</p>
            ) : (
              <>
                <p className="text-muted-foreground">Usage: {joinedLine(report, nowMs)}</p>
                {byWeekReset(report.accounts).map(({ account, usage }) => (
                  <p key={account} className="text-muted-foreground">
                    {account}
                    {usage.stale ? " (stale)" : ""}: {usageLine(usage, nowMs)}
                  </p>
                ))}
              </>
            )}
          </div>
          {report.problems.length > 0 && (
            <Alert>
              <AlertTitle>Part of the system did not read</AlertTitle>
              <AlertDescription className="wrap-anywhere">
                {report.problems.join("; ")}
              </AlertDescription>
            </Alert>
          )}
          <Readings now={now} report={report} />
          <Footprints now={now} report={report} />
        </>
      )}
    </section>
  )
}

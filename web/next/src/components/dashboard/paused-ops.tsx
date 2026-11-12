"use client"
"use no memo"

import type { OpsRow } from "@api/hono"
import * as React from "react"

import { useDashboard } from "@/components/dashboard/dashboard"
import { DataTable, textColumn, useStaticTable, type ColumnConfig } from "@/components/data-table"
import { useNow } from "@/lib/dashboard"
import { pausedOps, useOps, whenWords } from "@/lib/ops"
import { relativeTime } from "@/lib/time"

const pausedConfig: Record<string, ColumnConfig> = {
  // room for the longest script's name, Claude usage readings
  name: { extra: 24 },
  does: { extra: 36, flex: true, wrap: true },
  runs: { extra: 12 },
  beat: { extra: 12 },
}

// Pure: a paused job's last beat in words, or Never.
export const lastBeat = (row: OpsRow, now: number): string =>
  row.lastBeatAt ? relativeTime(row.lastBeatAt, new Date(now)) : "Never"

// Every cell muted: these jobs are paused on purpose, so none of them reads as a problem.
export const pausedColumns = (now: number) => [
  textColumn<OpsRow>("name", "Script", (row) => row.name, true),
  textColumn<OpsRow>("does", "Does", (row) => row.does, true),
  textColumn<OpsRow>("runs", "Runs", (row) => whenWords(row.schedule) ?? "", true),
  textColumn<OpsRow>("beat", "Last beat", (row) => lastBeat(row, now), true),
]

function Paused({ now, rows }: { now: number; rows: OpsRow[] }) {
  const columns = React.useMemo(() => pausedColumns(now), [now])
  const table = useStaticTable({
    columnConfig: pausedConfig,
    columns,
    data: rows,
    getRowId: (row) => row.job,
  })
  return (
    <section aria-labelledby="paused" className="flex flex-col gap-2">
      <h2 id="paused" className="text-muted-foreground text-sm font-medium">
        Paused
      </h2>
      <DataTable aria-label="Paused ops jobs" size="sm" table={table} />
    </section>
  )
}

// The scripts jobs.json pauses on purpose, which the sidebar's Scripts group leaves out, listed muted so they are not mistaken for down; nothing when none is paused.
export function PausedTable({ now, rows }: { now: number; rows: OpsRow[] }) {
  const paused = pausedOps(rows)
  if (paused.length === 0) return null
  return <Paused now={now} rows={paused} />
}

// The System page's Paused group, read through the sidebar's own ops query, on the owner rung alone.
export function PausedOps() {
  const { allowed } = useDashboard()
  const { data } = useOps(allowed)
  const now = useNow()
  return <PausedTable now={now} rows={data ?? []} />
}

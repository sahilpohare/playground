"use client"

import { useDashboard } from "@/components/dashboard/dashboard"
import { OwnerOnly } from "@/components/dashboard/owner-only"
import { ReadOnlyLine } from "@/components/dashboard/read-only-line"
import { Accounts } from "@/components/settings/accounts"
import { Extensions } from "@/components/settings/extensions"
import { Harness } from "@/components/settings/harness"
import { Jobs } from "@/components/settings/jobs"
import { MacChecks } from "@/components/settings/mac-checks"
import { Privacy } from "@/components/settings/privacy"
import { Remote } from "@/components/settings/remote"
import { Templates } from "@/components/settings/templates"
import { PageHeader } from "@/components/shell/page-header"
import { config } from "@/lib/config"

// The Settings page the user menu opens, on the owner rung, its sections one under the other; the hosted build keeps Remote alone, whose pair request is the one write it sends, under the read-only line.
export function SettingsHome() {
  const { allowed } = useDashboard()
  return (
    <>
      <PageHeader
        title="Settings"
        description="Accounts, the harness Alpha runs on, templates, extensions, privacy, jobs and how the Dashboard runs."
      />
      {allowed && config.hosted ? (
        <div className="flex flex-col gap-6">
          <ReadOnlyLine />
          <Remote />
        </div>
      ) : allowed ? (
        <div className="flex flex-col gap-6">
          <MacChecks />
          <Accounts />
          <Harness />
          <Templates />
          <Extensions />
          <Privacy />
          <Jobs />
          <Remote />
        </div>
      ) : (
        <OwnerOnly title="Settings are for the owner" why="They read this Mac's accounts" />
      )}
    </>
  )
}

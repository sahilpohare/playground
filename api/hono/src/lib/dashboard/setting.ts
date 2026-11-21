import { SESSION_EFFORTS, SESSION_MODELS } from "@packages/config/console"
import { localModelSchema } from "@packages/config/org"
import { dashboardSettingSummary } from "@packages/db"
import { z } from "zod"

// One model or one effort, each from its fixed list; nothing else rides along, so no request's words reach a session as a command.
const model = { model: z.enum(SESSION_MODELS) }
const effort = { effort: z.enum(SESSION_EFFORTS) }
export const settingSchema = z.union([z.strictObject(model), z.strictObject(effort)])

// A local model by the id config gives it (org.ts), for the hosted session alone, which restarts on its server.
const local = { local: localModelSchema.shape.id }

// The setting route's body: one setting and the composer's own id for it, which deliver() needs to read an effort command Claude Code holds while it compacts as QUEUED, as it reads a message.
const id = { id: z.uuid().optional() }
export const settingRequestSchema = z.union([
  z.strictObject({ ...id, ...model }),
  z.strictObject({ ...id, ...effort }),
  z.strictObject({ ...id, ...local }),
])

export type SessionSetting = z.infer<typeof settingSchema>

export type HostedSetting = SessionSetting | { local: string }
export type SessionEffort = (typeof SESSION_EFFORTS)[number]

// Pure: the one slash command a setting types, built from the lists alone.
export const settingCommand = (setting: SessionSetting): string =>
  "model" in setting ? `/model ${setting.model}` : `/effort ${setting.effort}`

// Pure: the setting's dashboard.setting row; a local model reads by its id, as its server names it.
export const settingSummary = (to: string, setting: HostedSetting): string =>
  "local" in setting
    ? dashboardSettingSummary(to, "model", `${setting.local} (local)`)
    : "model" in setting
      ? dashboardSettingSummary(to, "model", setting.model)
      : dashboardSettingSummary(to, "effort", setting.effort)

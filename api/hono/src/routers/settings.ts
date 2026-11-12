import { sValidator } from "@hono/standard-validator"
import {
  extScopeSchema,
  listSettings,
  readSetting,
  resetSetting,
  setSetting,
  settingHistory,
  shownValue,
} from "@packages/settings"
import { Hono } from "hono"
import { describeRoute } from "hono-openapi"
import { z } from "zod"

import {
  conflictErrorResponses,
  notFoundErrorResponses,
  validationErrorResponses,
} from "@/lib/error"
import { dataDir } from "@/lib/sessions/paths"
import { authMiddleware, guardWrites, requireConsoleRole, type StoreVariables } from "@/middlewares"
import { done, invalid, notFound, responses, whoOf, whyFields } from "@/routers/store"

const scopeQuery = z.strictObject({ org: z.string().optional() })

// Each row as the page reads it, a masked key's value by its last 4 characters (shownValue).
const shownRows = <R extends { key: string; value: unknown }>(rows: R[]): R[] =>
  rows.map((row) => ({ ...row, value: shownValue(row.key, row.value) }))

export const settingsRouter = new Hono<{ Variables: StoreVariables }>()
  .use("/*", guardWrites)
  .use("/*", authMiddleware)
  .use("/*", requireConsoleRole("owner"))
  .get(
    "/",
    describeRoute({
      tags: ["Settings"],
      description:
        "Every setting a piece defines, with its default and aliases, every row set at a scope, the values a session of your login reads (a job's row over its registry entry), and the settings' schemaVersion; a masked key's value (wa.device, wa.owner) shows its last 4 characters alone",
      ...responses(),
    }),
    async (c) => {
      const list = listSettings(dataDir())
      const values = Object.fromEntries(
        Object.entries(list.values).map(([key, value]) => [key, shownValue(key, value)]),
      )
      return c.json({ data: { ...list, rows: shownRows(list.rows), values } })
    },
  )
  .get(
    "/:key",
    describeRoute({
      tags: ["Settings"],
      description:
        "One setting as a session of the org reads it: its value, its default and every row that sets it, an alias read through to its key, and a masked key's value by its last 4 characters alone",
      ...responses(notFoundErrorResponses),
    }),
    sValidator("query", scopeQuery, invalid),
    async (c) => {
      const read = readSetting(dataDir(), c.req.param("key"), c.req.valid("query").org)
      if (!read) throw notFound(`setting ${c.req.param("key")}`)
      return c.json({
        data: { ...read, rows: shownRows(read.rows), value: shownValue(read.key, read.value) },
      })
    },
  )
  .get(
    "/:key/why",
    describeRoute({
      tags: ["Settings"],
      description:
        "Every change to a setting, under its key and each alias, newest first, with who asked, how it came in and why, a masked key's values by their last 4 characters alone",
      ...responses(notFoundErrorResponses),
    }),
    async (c) => {
      const history = settingHistory(dataDir(), c.req.param("key"))
      if (!history) throw notFound(`setting ${c.req.param("key")}`)
      return c.json({
        data: history.map((entry) => ({
          ...entry,
          newValue: shownValue(entry.key, entry.newValue),
          oldValue: shownValue(entry.key, entry.oldValue),
        })),
      })
    },
  )
  .put(
    "/:key",
    describeRoute({
      tags: ["Settings"],
      description:
        "Set a setting at a scope with a reason; its key's schema checks the value, and a secret-shaped value is refused; the answer gives a masked key's value by its last 4 characters alone",
      ...responses(validationErrorResponses),
    }),
    sValidator(
      "json",
      z.strictObject({ ...whyFields, scope: extScopeSchema, value: z.unknown() }),
      invalid,
    ),
    async (c) => {
      const input = c.req.valid("json")
      const set = done(
        setSetting(dataDir(), { ...input, key: c.req.param("key") }, await whoOf(c, input)),
      )
      return c.json({
        data: { key: set.key, scope: set.scope, value: shownValue(set.key, set.value) },
      })
    },
  )
  .post(
    "/:key/reset",
    describeRoute({
      tags: ["Settings"],
      description: "Take a setting back to its default at a scope, with a reason",
      ...responses(validationErrorResponses, notFoundErrorResponses, conflictErrorResponses),
    }),
    sValidator("json", z.strictObject({ ...whyFields, scope: extScopeSchema }), invalid),
    async (c) => {
      const input = c.req.valid("json")
      const reset = done(
        resetSetting(
          dataDir(),
          { key: c.req.param("key"), scope: input.scope },
          await whoOf(c, input),
        ),
      )
      return c.json({ data: { key: reset.key, scope: reset.scope } })
    },
  )

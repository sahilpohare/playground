// The ids of the fixes the first run's checks offer, each run by POST /api/v1/onboard/fix/:id from a fixed argv; on a fixture stack a made-up fix adds its id to fixtureFixed, and the fixture's rows read it as ok.
export const FIX_IDS = [
  "claude",
  "database",
  "docker",
  "gh-login",
  "git",
  "herdr",
  "node",
  "pglite",
  "proxy",
  "python",
  "trust",
] as const
export type FixId = (typeof FIX_IDS)[number]
export const fixtureFixed = new Set<FixId>()

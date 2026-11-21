// What a new user meets first: the installer, first run's trust and setup, and the first start; a PR changing any of them merges only on this gate's PASS at its head (pr-merge's new-user gate). A path ending in / takes everything under it.
export const NEW_USER_PATHS = [
  "api/hono/src/lib/onboard/",
  "api/hono/src/lib/setup/",
  "api/hono/src/routers/onboard.ts",
  "install.sh",
  "packages/scripts/src/new-user-gate/",
  "packages/scripts/src/playground/claude-trust.ts",
  "packages/scripts/src/playground/uninstall.ts",
  "scripts/spawn.sh",
  "web/next/src/components/first-run/",
  "web/next/src/lib/first-run.ts",
] as const

// Pure: each changed file a path of NEW_USER_PATHS covers.
export const newUserFiles = (files: string[]): string[] =>
  files.filter((file) =>
    NEW_USER_PATHS.some((path) => (path.endsWith("/") ? file.startsWith(path) : file === path)),
  )

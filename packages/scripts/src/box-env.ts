// The variables a box's child takes from this process: none that names live state (a portless state folder, a herdr socket, the data folder), since an absolute path there survives a new HOME and reaches the machine's own.
export const BOX_ENV_KEYS: readonly string[] = [
  "LANG",
  "LC_ALL",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "USER",
]

// A child's whole env for a box at home: keys from process.env, HOME, then extra over them, an undefined value dropping its key.
export const boxEnv = (
  home: string,
  extra: Record<string, string | undefined> = {},
  keys: readonly string[] = BOX_ENV_KEYS,
): Record<string, string> => {
  const env: Record<string, string> = {}
  for (const key of keys) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  env.HOME = home
  for (const [key, value] of Object.entries(extra)) {
    if (value === undefined) delete env[key]
    else env[key] = value
  }
  return env
}

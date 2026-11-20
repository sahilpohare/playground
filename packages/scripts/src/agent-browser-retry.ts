export const NETWORK_CHANGED_RETRIES = 2
export const NETWORK_CHANGED_WAIT_MS = 1_000

// Docker's network churn trips Chromium's network-change notifier, which fails an open with net::ERR_NETWORK_CHANGED, and the same open loads a moment later; every agent-browser caller asks here before it tries a failed command again: the wait, logged, or null to throw.
export const networkChangedWait = (
  args: readonly string[],
  error: string,
  tries: number,
  log: (line: string) => void = (line) => console.error(line),
): number | null => {
  if (args[0] !== "open" || tries >= NETWORK_CHANGED_RETRIES) return null
  if (!error.includes("net::ERR_NETWORK_CHANGED")) return null
  log(
    `agent-browser open ${args[1] ?? ""}: net::ERR_NETWORK_CHANGED, retry ${tries + 1} of ${NETWORK_CHANGED_RETRIES} in ${NETWORK_CHANGED_WAIT_MS}ms`,
  )
  return NETWORK_CHANGED_WAIT_MS
}

const RUN_TIMEOUT_MS = 30_000

// An argv run with no shell, in cwd when given, its output read whole and killed past its timeout, with the signal that stopped it: the step a grant decision's Approve runs, a root step's with system/root.ts's ROOT_TIMEOUT_MS (ArgvRun in inbox.ts), and a local pick's model start (local-load.ts); input goes to its stdin, so a peer install's password never sits in an argv.
export const runArgv = async (
  argv: string[],
  timeout: number = RUN_TIMEOUT_MS,
  input?: string,
  cwd?: string,
): Promise<{ code: number; err: string; out: string; signal?: number | NodeJS.Signals | null }> => {
  const child = Bun.spawn(argv, {
    cwd,
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    timeout,
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code: code ?? 1, err: err.trim(), out: out.trim(), signal: child.signalCode }
}

// The one reader of a hook's input, stdin read by the hook's deadline, so a runner that leaves stdin open never holds a hook to the runner's own timeout.

// The hook's deadline, from its process's start, inside the runner's 15 s timeout.
export const DEADLINE = 13_000

// What a hook does when its input never arrives: a guard refuses its call, since the runner's timeout would let it run, and a recorder exits 0 with nothing written.
export type Kind = "guard" | "recorder"

// The hook's stdin whole; a read still open at the deadline ends the process, a guard's with exit 2 and its reason on stderr, a recorder's with exit 0.
export async function input(name: string, kind: Kind, deadline = DEADLINE): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const raw = await Promise.race([
    Bun.stdin.text(),
    new Promise<undefined>((done) => {
      timer = setTimeout(() => done(undefined), deadline - performance.now())
    }),
  ]).finally(() => clearTimeout(timer))
  if (raw !== undefined) return raw
  if (kind === "recorder") process.exit(0)
  console.error(
    `${name} hook: the call's input did not arrive by its deadline, about ${deadline / 1000} s, inside the runner's 15 s timeout, so the call is refused; report it to your lead.`,
  )
  process.exit(2)
}

// A probe spawn.sh started with --ssh runs its claude on another machine, so no registry file here proves it live; its pane here does, while the ssh that carries it runs. Ops' sweep and the Dashboard's live list both read it by this one rule, each passing in its own reads.
export type SshLaunch = { name: string; server: string; sessionId: string }

const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
// One shell word as spawn.sh's printf %q writes it, so a path may hold an escaped space
const WORD = "(?:\\\\.|[^\\s\\\\])+"
// spawn.sh resume <name> <folder> <session> <flags…>, its program and folder %q words
const EXEC_LINE = new RegExp(
  `^exec ${WORD} resume (${WORD}) ${WORD} (${SESSION_ID})((?: ${WORD})*)$`,
)

// Pure: the launch a resume record names when its exec line starts an --ssh probe, else null; its server is the record's server line, playground when it has none, as spawn.sh restore reads it.
export function sshLaunchOf(record: string): SshLaunch | null {
  const lines = record.split("\n")
  const words = lines.find((line) => line.startsWith("exec "))?.match(EXEC_LINE)
  // the flags are the words after the session, so a folder whose name holds --ssh reads as no launch
  if (!words?.[1] || !words[2] || !/ --ssh \S/.test(words[3] ?? "")) return null
  const server = lines
    .find((line) => line.startsWith("# server: "))
    ?.slice(10)
    .trim()
  return { name: words[1], server: server || "playground", sessionId: words[2] }
}

// Pure: the ssh process that carries a launch in a pane, or undefined: the pane is on the launch's server, carries its name as its label and runs ssh in its foreground (its argv's first word), which it does while the link to the far machine stands, so a pane back at its shell holds none.
export function sshProcessOf<P extends { argv?: string[] | null }>(
  launch: SshLaunch,
  server: string,
  pane: { label?: string | null; processes: P[] },
): P | undefined {
  if (server !== launch.server || pane.label !== launch.name) return undefined
  return pane.processes.find((p) => /(^|\/)ssh$/.test(p.argv?.[0] ?? ""))
}

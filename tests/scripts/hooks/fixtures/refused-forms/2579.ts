import { type Group, type Paths, type Row } from "./_shared"

// #2579: a quoted glob character on a remote line or in a script ssh feeds a remote shell is text, and a fed script's verdict holds when readers run before the ssh, its pipe feeds a reader, or a call that feeds no shell follows it; each passing form beside its nearest refused twin; rows are data, as refused-forms.ts says.

// no-extensions-write: a runner's fed scripts and quoted * on the line, which write nothing under the root
const extensionsControls = ({ HOME }: Pick<Paths, "HOME">): Row[] => [
  [
    "a quoted * in a remote line's awk program",
    `ssh box "awk '{ print 100 * (\\$1) }' /proc/loadavg"`,
  ],
  [
    "a quoted * in a heredoc's awk program a remote shell runs",
    "ssh box bash -s <<'EOF'\nawk '{ print 100 * ($1) }' /proc/loadavg\nEOF",
  ],
  ["a runner's awk script fed to a remote shell", `ssh box bash -s -- a b < ${HOME}/stats.sh`],
  [
    "a runner's awk script fed to a remote shell, another ssh after it",
    `ssh -o BatchMode=yes box bash -s -- a b < ${HOME}/stats.sh; ssh box grep -c "' 500 '\\|\\" 500 " /var/log/serve.log`,
  ],
  ["a runner's loop script fed to a remote shell", `ssh box bash -s < ${HOME}/dl.sh`],
  [
    "a runner's loop script fed to a remote shell, readers before it",
    `head -5 ${HOME}/dl.sh; ssh box bash -s < ${HOME}/dl.sh`,
  ],
  [
    "a runner's loop script fed to a remote shell, readers before it and a filter after",
    `head -5 ${HOME}/dl.sh; tail -3 ${HOME}/dl.sh; ssh box bash -s < ${HOME}/dl.sh 2>&1 | grep -v '^l\\|^d\\|^total'`,
  ],
]

// no-extensions-write: an unquoted glob that names the root, and a fed script a line may write first or runs from a file it wrote
const extensionsRefused = ({ HOME }: Pick<Paths, "HOME">): Row[] => [
  ["an unquoted glob naming the root on a remote line", "ssh box 'touch .playground/ext*/x'"],
  [
    "an unquoted glob naming the root in a heredoc a remote shell runs",
    "ssh box bash -s <<'EOF'\ntouch .playground/ext*/x\nEOF",
  ],
  [
    "a script naming the root written before the ssh that feeds it",
    `echo 'touch .playground/extensions/x' > ${HOME}/w.sh; ssh box bash -s < ${HOME}/w.sh`,
  ],
  [
    "a fed script a call beside the backgrounded ssh may write",
    `ssh box bash -s < ${HOME}/stats.sh & echo x > ${HOME}/stats.sh`,
  ],
  ["a fed script that runs a script it writes with sed", `ssh box bash -s < ${HOME}/serve.sh`],
  [
    "a fed script naming the root, readers before it",
    `head -5 ${HOME}/peer-write.sh; ssh box bash -s < ${HOME}/peer-write.sh`,
  ],
  [
    "a fed script naming the root, readers before it and a filter after",
    `head -5 ${HOME}/peer-write.sh; tail -3 ${HOME}/peer-write.sh; ssh box bash -s < ${HOME}/peer-write.sh 2>&1 | grep -v '^l'`,
  ],
  [
    "a fed script naming the root, another ssh after it",
    `ssh box bash -s < ${HOME}/peer-write.sh; ssh box grep -c x /var/log/serve.log`,
  ],
  [
    "a fed script naming the root, its pipe feeding a reader",
    `ssh box bash -s < ${HOME}/peer-write.sh | head -80`,
  ],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home", "tmp"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...extensionsControls(paths), ...extensionsRefused(paths)],
  },
]

export const allowed: string[] = extensionsControls({ HOME: "" }).map(([what]) => what)

import { type Group, type Paths, type Row } from "./_shared"

// #2553: a writing xargs whose stdin the hook cannot read is refused, as a removing one is, here and on a remote line alike, since that stdin may name the root; each passing form beside its nearest refused twin; rows are data, as refused-forms.ts says.

// no-extensions-write: an xargs whose stdin the hook reads and finds no root path in, and one that runs no writer
const extensionsControls = (): Row[] => [
  ["a path outside the root piped to an xargs touch", "echo notes/x | xargs touch"],
  [
    "output the hook cannot read piped to an xargs echo, which writes nothing",
    "mystery | xargs echo",
  ],
  ["output the hook cannot read piped to an xargs grep, which reads", "mystery | xargs grep -l x"],
]

// no-extensions-write: a writing xargs, local or remote, whose stdin is output, a file or a folder the hook cannot read
const extensionsRefused = ({ WORK }: Pick<Paths, "WORK">): Row[] => [
  ["output the hook cannot read piped to an xargs touch", "mystery | xargs touch"],
  ["a listing the hook cannot read piped to an xargs touch", "ls | xargs touch"],
  [
    "output the hook cannot read piped to an xargs touch after a cd",
    "cd ~ && mystery | xargs touch",
  ],
  ["output the hook cannot read piped to an xargs mkdir", "mystery | xargs mkdir -p"],
  ["a missing file fed to an xargs touch", "xargs touch < list"],
  ["output the hook cannot read piped to a remote xargs touch", "mystery | ssh box xargs touch"],
  ["a listing the hook cannot read piped to a remote xargs touch", "ls | ssh box xargs touch"],
  ["a missing file ssh hands a remote xargs touch", "ssh box xargs touch < list"],
  [
    "a folder ssh hands a remote xargs touch, which the hook cannot read as a file",
    `ssh box xargs touch < ${WORK}`,
  ],
  [
    "the root's path piped to ssh, whose remote xargs reads a file of its own the hook cannot read",
    "echo .playground/extensions/.no-such-file | ssh box 'xargs touch < list'",
  ],
  [
    "output the hook cannot read piped to an xargs touch inside bash -c",
    "bash -c 'mystery | xargs touch'",
  ],
  [
    "output the hook cannot read piped to an xargs touch inside sh -c",
    "sh -c 'mystery | xargs touch'",
  ],
  [
    "output the hook cannot read piped to an xargs touch inside eval",
    "eval 'mystery | xargs touch'",
  ],
  [
    "a listing the hook cannot read piped to an xargs touch on a quoted remote line",
    "ssh box 'ls | xargs touch'",
  ],
  ["output the hook cannot read piped to an xargs touch behind nice", "mystery | nice xargs touch"],
  ["output the hook cannot read piped to an xargs -I{} cp", "mystery | xargs -I{} cp notes/x {}"],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home", "tmp"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...extensionsControls(), ...extensionsRefused(paths)],
  },
]

export const allowed: string[] = extensionsControls().map(([what]) => what)

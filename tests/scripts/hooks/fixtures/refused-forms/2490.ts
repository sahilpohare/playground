import { type Group, type Paths, type Row } from "./_shared"

// #2490: the words piped into ssh, ssh's own here-string or heredoc, or a file ssh reads, reach a remote xargs as its stdin, as they reach its local twin's, each passing form beside its nearest refused twin; rows are data, as refused-forms.ts says.

// no-extensions-write: a remote xargs that reads no root path or none of ssh's stdin, which its local twin passes too; one whose stdin the hook cannot read is #2553's
const extensionsControls = ({ WORDS }: Pick<Paths, "WORDS">): Row[] => [
  ["a path outside the root piped to a remote xargs touch", "echo notes/x | ssh box xargs touch"],
  [
    "the root's path piped to ssh -n, whose remote xargs reads /dev/null",
    "echo .playground/extensions/.no-such-file | ssh -n box xargs touch",
  ],
  [
    "a file of words outside the root ssh hands a remote xargs touch",
    `ssh box xargs touch < ${WORDS}`,
  ],
  [
    "a path outside the root in a here-string ssh hands a remote xargs touch",
    "ssh box xargs touch <<< notes/x",
  ],
  [
    "a path outside the root in a heredoc ssh hands a remote xargs touch",
    "ssh box xargs touch <<EOF\nnotes/x\nEOF",
  ],
  [
    "a path outside the root in a quoted heredoc ssh hands a remote xargs touch",
    "ssh box xargs touch <<'EOF'\nnotes/x\nEOF",
  ],
]

// no-extensions-write: the root's path in the words a remote xargs reads from ssh's stdin
const extensionsRefused = ({ HOME }: Pick<Paths, "HOME">): Row[] => [
  [
    "the root's path piped to a remote xargs touch",
    "echo .playground/extensions/.no-such-file | ssh box xargs touch",
  ],
  [
    "the root's path piped to a remote xargs -r touch",
    "echo .playground/extensions/.no-such-file | ssh box xargs -r touch",
  ],
  [
    "the root's path printed into a remote xargs touch",
    "printf '%s\\n' .playground/extensions/.no-such-file | ssh box xargs touch",
  ],
  [
    "the root's path in a here-string ssh hands a remote xargs touch",
    "ssh box xargs touch <<< .playground/extensions/.no-such-file",
  ],
  [
    "the root's path in a heredoc ssh hands a remote xargs touch",
    "ssh box xargs touch <<EOF\n.playground/extensions/.no-such-file\nEOF",
  ],
  [
    "the root's path in a quoted heredoc ssh hands a remote xargs touch",
    "ssh box xargs touch <<'EOF'\n.playground/extensions/.no-such-file\nEOF",
  ],
  [
    "a file naming the root's path ssh hands a remote xargs touch",
    `ssh box xargs touch < ${HOME}/peer-write.sh`,
  ],
  [
    "a file naming the root's path ssh reads by a relative path from the folder it runs in",
    "ssh box xargs touch < peer-write.sh",
    "home",
  ],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home", "tmp"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...extensionsControls(paths), ...extensionsRefused(paths)],
  },
]

export const allowed: string[] = extensionsControls({ WORDS: "" }).map(([what]) => what)

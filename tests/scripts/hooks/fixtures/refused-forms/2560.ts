import { type Group, type Paths, type Row } from "./_shared"

// #2560: the pipe into a brace group, and ssh's stdin on a remote line, reach a writing xargs past the first command, as they reach its plain twin, and a group's own input redirect stays one the hook does not read (PG-1175), refused for a writing xargs as #2553 refuses any stdin it cannot read; each passing form beside its nearest refused twin; rows are data, as refused-forms.ts says.
// A cd ~ reads the process's own home, so its rows run in the process folders, as 356's do.

// no-extensions-write: the same pipes fed a path outside the root
const controls = ({ HOME, WORDS }: Pick<Paths, "HOME" | "WORDS">): Row[] => [
  [
    "a path outside the root piped into a brace group's later xargs touch",
    "echo notes/x | { true; xargs touch; }",
  ],
  [
    "a file of words outside the root fed to an xargs touch outside any group",
    `xargs touch < ${WORDS}`,
  ],
  [
    "a path outside the root piped to a remote line's later xargs touch",
    "echo notes/x | ssh box 'true; xargs touch'",
  ],
  [
    "a path outside the root in a here-string ssh hands a remote line's later xargs touch",
    "ssh box 'true; xargs touch' <<< notes/x",
  ],
  [
    "the root's path piped into a brace group whose xargs touch reads a pipe of its own naming an outside path",
    `echo ${HOME}/.playground/extensions/.no-such-file | { echo notes/x | xargs touch; }`,
  ],
]
const cdControls = (): Row[] => [
  [
    "a path outside the root piped into a brace group whose xargs touch follows a cd ~",
    "echo notes/x | { cd ~ && xargs touch; }",
  ],
  [
    "a path outside the root piped to a remote xargs touch after a cd ~",
    "echo notes/x | ssh box 'cd ~ && xargs touch'",
  ],
]

// no-extensions-write: the root's path, or a stdin the hook does not read, reaching a writing xargs that is not the first command of its group or remote line
const refused = ({ HOME, WORDS }: Pick<Paths, "HOME" | "WORDS">): Row[] => [
  [
    "the root's path piped into a brace group's later xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { true; xargs touch; }`,
  ],
  [
    "the root's path piped to a remote line's later xargs touch",
    "echo .playground/extensions/.no-such-file | ssh box 'true; xargs touch'",
  ],
  [
    "the root's path in a here-string ssh hands a remote line's later xargs touch",
    "ssh box 'true; xargs touch' <<< .playground/extensions/.no-such-file",
  ],
  [
    "a pipe into a brace group whose exec swaps stdin before its xargs touch",
    "echo notes/x | { exec 0<&3; xargs touch; } 3<<< .playground/extensions/.no-such-file",
  ],
  [
    "a file naming the root's path fed to a subshell's xargs touch",
    `(cd ${HOME} && xargs touch) < ${HOME}/peer-write.sh`,
  ],
  [
    "a file naming the root's path fed to a brace group's xargs touch",
    `{ cd ${HOME} && xargs touch; } < ${HOME}/peer-write.sh`,
  ],
  [
    "a file of words outside the root fed to a brace group's xargs touch, which the hook does not read",
    `{ true; xargs touch; } < ${WORDS}`,
  ],
  [
    "the root's path piped into a nested brace group's later xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { true; { true; xargs touch; }; }`,
  ],
  [
    "the root's path piped into a brace group's if body's xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { if true; then xargs touch; fi; }`,
  ],
  [
    "the root's path piped into a brace group's while body's xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { while true; do xargs touch; break; done; }`,
  ],
  [
    "the root's path piped into a brace group's for body's xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { for i in 1; do xargs touch; done; }`,
  ],
  [
    "the root's path piped into a brace group whose function runs an xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { f() { xargs touch; }; f; }`,
  ],
  [
    "the root's path piped into a brace group's later xargs touch, the group piped on to cat",
    `echo ${HOME}/.playground/extensions/.no-such-file | { true; xargs touch; } | cat`,
  ],
  [
    "the root's path piped into a brace group whose later command is exec xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { true; exec xargs touch; }`,
  ],
  [
    "the root's path piped into a brace group whose bare exec comes before its xargs touch",
    `echo ${HOME}/.playground/extensions/.no-such-file | { exec; xargs touch; }`,
  ],
  [
    "a path outside the root piped into a brace group whose exec moves stderr before its xargs touch, which the hook then does not read",
    "echo notes/x | { exec 2>/dev/null; xargs touch; }",
  ],
  [
    "a path outside the root piped into a brace group whose exec moves stdout before its xargs touch, which the hook then does not read",
    "echo notes/x | { exec >/dev/null; xargs touch; }",
  ],
  [
    "a path outside the root piped into a brace group whose exec copies stdin before its xargs touch, which the hook then does not read",
    "echo notes/x | { exec 3<&0; xargs touch; }",
  ],
  [
    "a pipe into a brace group whose quoted exec swaps stdin before its xargs touch",
    `echo notes/x | { "exec" 0<&3; xargs touch; } 3<<< ${HOME}/.playground/extensions/.no-such-file`,
  ],
  [
    "a pipe into a brace group whose exec behind command swaps stdin before its xargs touch",
    `echo notes/x | { command exec 0<&3; xargs touch; } 3<<< ${HOME}/.playground/extensions/.no-such-file`,
  ],
  [
    "an outside path piped into a brace group whose xargs touch reads a pipe of its own naming the root",
    `echo notes/x | { echo ${HOME}/.playground/extensions/.no-such-file | xargs touch; }`,
  ],
  [
    "an outside path piped into a brace group whose later xargs touch reads a pipe of its own naming the root",
    `echo notes/x | { true; echo ${HOME}/.playground/extensions/.no-such-file | xargs touch; }`,
  ],
]
const cdRefused = ({ WORDS }: Pick<Paths, "WORDS">): Row[] => [
  [
    "a file of words outside the root fed to a brace group whose xargs touch follows a cd ~, which the hook does not read",
    `{ cd ~ && xargs touch; } < ${WORDS}`,
  ],
  [
    "the root's path piped into a brace group's later xargs touch after a cd ~",
    "cd ~ && echo .playground/extensions/.no-such-file | { true; xargs touch; }",
  ],
  [
    "the root's path piped into a brace group whose xargs touch follows a cd ~",
    "echo .playground/extensions/.no-such-file | { cd ~ && xargs touch; }",
  ],
  [
    "the root's path piped to a remote xargs touch after a cd ~",
    "echo .playground/extensions/.no-such-file | ssh box 'cd ~ && xargs touch'",
  ],
  [
    "the root's path in a here-string into an xargs touch after a cd ~",
    "cd ~ && xargs touch <<< .playground/extensions/.no-such-file",
  ],
  [
    "the root's path in a heredoc into an xargs touch after a cd ~",
    "cd ~ && xargs touch <<EOF\n.playground/extensions/.no-such-file\nEOF",
  ],
  [
    "the root's path in a quoted heredoc into an xargs touch after a cd ~",
    "cd ~ && xargs touch <<'EOF'\n.playground/extensions/.no-such-file\nEOF",
  ],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home", "tmp"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...controls(paths), ...refused(paths)],
  },
  {
    folders: ["process home", "process tmp", "process worktree"],
    guards: ["no-extensions-write"],
    rows: (paths) => [...cdControls(), ...cdRefused(paths)],
  },
]

export const allowed: string[] = [...controls({ HOME: "", WORDS: "" }), ...cdControls()].map(
  ([what]) => what,
)

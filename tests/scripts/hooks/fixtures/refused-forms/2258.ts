import type { Group, Row } from "./_shared"

// #2258: text that reaches a git hook by a path the hook write does not follow (another program, a copy from stdin, a block copy, a move of a script file, a shell function's output, a case-changed spelling), read under one policy: a command that writes, moves or copies into a hook file takes every text on its line as the hook's text; rows are data, as refused-forms.ts says.
const HOOK = ".git/hooks/pre-commit"
const TEXT = "touch ~/.playground/extensions/x"
// each held text and its near twins: in a comment, after a header line, and joined across a backslash-newline
const twins = (what: string, form: (text: string) => string): Row[] => [
  [what, form(TEXT)],
  [`${what}, the text in a comment`, form(`# ${TEXT}`)],
  [`${what}, the text after a header line`, form(`#!/bin/sh\n${TEXT}`)],
  [
    `${what}, the text joined across a backslash-newline`,
    form("touch ~/.playground/ext\\\nensions/x"),
  ],
]

const held = (): Row[] => [
  ...twins(
    "an echo of the data folder piped through cat into a git hook",
    (text) => `echo '${text}' | cat > ${HOOK}`,
  ),
  ...twins(
    "an echo of the data folder piped through two tees into a git hook",
    (text) => `echo '${text}' | tee /dev/null | tee ${HOOK}`,
  ),
  ...twins(
    "a here-string of the data folder fed to cat into a git hook",
    (text) => `cat > ${HOOK} <<< '${text}'`,
  ),
  ...twins(
    "an echo of the data folder piped into a git hook by dd",
    (text) => `echo '${text}' | dd of=${HOOK}`,
  ),
  ...twins(
    "an echo of the data folder copied from stdin into a git hook",
    (text) => `echo '${text}' | cp /dev/stdin ${HOOK}`,
  ),
  ...twins(
    "an echo of the data folder written to a script, then moved into a git hook",
    (text) => `echo '${text}' > a.sh && mv a.sh ${HOOK}`,
  ),
  ...twins(
    "a function that echoes the data folder, called into a git hook",
    (text) => `f() { echo '${text}'; }; f > ${HOOK}`,
  ),
  ...twins(
    "a function that echoes the data folder, defined with a redirect into a git hook",
    (text) => `f() { echo '${text}'; } > ${HOOK}; f`,
  ),
  [
    "an in-place perl that writes the data folder in upper case into a git hook",
    String.raw`perl -pi -e 's/a/touch \U~\/.PLAYGROUND\E\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl that writes the data folder in upper case into a git hook, in a comment",
    String.raw`perl -pi -e 's/a/# touch \U~\/.PLAYGROUND\E\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl that writes the data folder in upper case into a git hook, after a header line",
    String.raw`perl -pi -e 's/a/#!\/bin\/sh\ntouch \U~\/.PLAYGROUND\E\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl that writes the data folder in upper case into a git hook, joined across a backslash-newline",
    String.raw`perl -pi -e 's/a/touch \U~\/.PLAY\\\nGROUND\E\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a cd home and a remover of the dot into a git hook, in a comment",
    String.raw`sed -i '' 's/a/# cd ~\/. \&\& rm -rf ./' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a cd home and a remover of the dot into a git hook, after a header line",
    String.raw`sed -i '' 's/a/#!\/bin\/sh\ncd ~\/. \&\& rm -rf ./' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed that writes a cd home and a remover of the dot into a git hook, joined across a backslash-newline",
    String.raw`sed -i '' 's/a/cd ~\/. \&\& r\\\nm -rf ./' .git/hooks/pre-commit`,
  ],
]

// controls that keep canary's verdict: a hook written with no data-folder text, data-folder text piped into a file that is not a hook
const controls = (): Row[] => [
  [
    "an echo of a plain command piped through cat into a git hook",
    `echo 'bun test' | cat > ${HOOK}`,
  ],
  ["an echo of a plain command piped into a git hook by dd", `echo 'bun test' | dd of=${HOOK}`],
  [
    "a printf of a lefthook hook redirected into a git hook",
    String.raw`printf '#!/bin/sh\nbunx lefthook run pre-commit "$@"\n' > .git/hooks/pre-commit`,
  ],
  ["an echo of the data folder piped through cat into a note", `echo '${TEXT}' | cat > notes.txt`],
  ["an echo of the data folder piped into a note by dd", `echo '${TEXT}' | dd of=notes.txt`],
  [
    "an echo of the data folder written to a script, then moved to another script",
    `echo '${TEXT}' > a.sh && mv a.sh b.sh`,
  ],
]

const rows = () => [...held(), ...controls()]

export const groups: Group[] = [
  { folders: ["data folder", "home", "process worktree"], guards: ["no-extensions-write"], rows },
]

export const allowed: string[] = controls().map(([what]) => what)

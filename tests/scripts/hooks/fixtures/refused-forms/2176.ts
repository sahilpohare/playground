import type { Group, Paths, Row } from "./_shared"

// #2176: an in-place sed whose script spells the root other than literally, by a glob or behind sed's escaped slashes, writes that path into a file a shell may run later, a git hook included, which holds() let pass since it read only the literal spelling; each row also runs after a sleep, on a line read whole; rows are data, as refused-forms.ts says.
const WHOLE = ", on a line read whole"
const rows = ({ DATA }: Paths): Row[] => [
  [
    "an in-place sed whose s/// writes a * glob of the root under ~ into a file",
    String.raw`sed -i '' 's/a/touch ~\/.play*\/extensions\/x/' run.sh`,
  ],
  [
    "an in-place sed whose s/// writes a * glob of the root under ~ into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose -e s/// writes a * glob of the root into a git hook",
    String.raw`sed -i '' -e 's/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a ? glob of the root into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/.p?ayground\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a [ glob of the root into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/.[p]layground\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a { glob of the root into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/.{playground,x}\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of a folder above the root into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root under $HOME into a git hook",
    String.raw`sed -i '' 's/a/touch $HOME\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the root behind escaped slashes into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/.playground\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root, with a redirect into a git hook after it",
    String.raw`sed -i '' 's/a/touch ~\/.play*\/extensions\/x/' run.sh; echo x >> .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// spells the root by the text its & matched",
    String.raw`sed -i '' 's/layground/~\/.p&\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// spells the root by a group it matched",
    String.raw`sed -i '' 's/\(layground\)/~\/.p\1\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose second s/// writes a glob of the root, after an address naming s/",
    String.raw`sed -i '' '/as/d;s/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob through a link to the root into a git hook",
    String.raw`sed -i '' 's/a/touch ~\/store\/*\/x/' .git/hooks/pre-commit`,
    "home",
  ],
  [
    "an in-place sed whose s/// writes a glob of the root after a quoted $HOME",
    String.raw`sed -i '' 's/a/touch "$HOME"\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root with a quote inside it",
    String.raw`sed -i '' 's/a/touch ~\/".play"*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root in a subshell",
    String.raw`sed -i '' 's/a/(ls ~\/.play*\/ext*)/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root in a substitution",
    String.raw`sed -i '' 's/a/$(ls ~\/.play*\/ext*)/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a zsh (…) glob of the root",
    String.raw`sed -i '' 's/a/touch ~\/.(playground|x)\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root in a brace list",
    String.raw`sed -i '' 's/a/touch {x,~\/.play*\/extensions}/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the root after a defaulted HOME",
    "sed -i '' 's/a/touch ${HOME:-\\/x}\\/.play*\\/extensions/' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed by BSD's -I whose s/// writes a glob of the root",
    String.raw`sed -I '' 's/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed by --in-place= whose s/// writes a glob of the root",
    String.raw`sed --in-place='' 's/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s||| writes a glob of the root",
    `sed -i '' 's|a|touch ~/.play*/extensions/x|' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s,,, writes a glob of the root",
    `sed -i '' 's,a,touch ~/.play*/extensions/x,' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes a relative glob that climbs to the root by ..",
    String.raw`sed -i '' 's/a/rm -rf ..\/..\/..\/..\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes the root's relative path that climbs to it by ..",
    String.raw`sed -i '' 's/a/rm -rf ..\/..\/..\/..\/.playground\/extensions\/x/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes a relative glob that climbs above the home and globs it",
    String.raw`sed -i '' 's/a/rm -rf ..\/..\/..\/..\/..\/*\/.play*\/ext*/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes a relative glob that climbs by .. through a folder",
    String.raw`sed -i '' 's/a/rm -rf a\/..\/..\/..\/..\/..\/.play*\/ext*/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes the root's relative path that climbs by .. through a folder",
    String.raw`sed -i '' 's/a/rm -rf a\/..\/..\/..\/..\/..\/.playground\/extensions/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes a relative glob that climbs by .. through a glob folder",
    String.raw`sed -i '' 's/a/rm -rf *\/..\/..\/..\/..\/..\/.play*\/ext*/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose s/// writes the root's relative path that climbs by .. through a glob folder",
    String.raw`sed -i '' 's/a/rm -rf *\/..\/..\/..\/..\/..\/.playground\/extensions/' .git/hooks/pre-commit`,
    "process worktree",
  ],
  [
    "an in-place sed whose a\\ text writes a glob of the root",
    "sed -i '' '1a\\\ntouch ~/.play*/extensions/x' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed whose i\\ text writes a glob of the root",
    "sed -i '' '1i\\\ntouch ~/.play*/extensions/x' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed whose a\\ text writes the root's path",
    "sed -i '' '1a\\\ntouch ~/.playground/extensions/x' .git/hooks/pre-commit",
  ],
  ["an in-place sed whose a\\ text writes plain words", "sed -i '' '1a\\\nhello world' notes.md"],
  ["an in-place sed whose i\\ text writes a shebang", "sed -i '' '1i\\\n#!/bin/sh' run.sh"],
  [
    "an in-place sed whose a\\ text writes a relative glob",
    "sed -i '' '$a\\\nsrc/**/*.ts' .gitignore",
  ],
  [
    "an in-place sed whose c\\ text writes a glob outside the root",
    "sed -i '' '1c\\\n/tmp/*.log' notes.md",
  ],
  [
    "an in-place sed whose a\\ text writes plain words after a space",
    "sed -i '' '1a\\ hello world' notes.md",
  ],
  [
    "an in-place sed whose s/// writes a relative ** glob after ..",
    String.raw`sed -i '' 's/a/..\/src\/**\/*.ts/' tsconfig.json`,
  ],
  [
    "an in-place sed whose s/// writes a relative glob after two ..",
    String.raw`sed -i '' 's/a/..\/..\/packages\/*\/*/' package.json`,
  ],
  [
    "an in-place sed whose s/// writes a relative ** glob",
    String.raw`sed -i '' 's/a/src\/**\/*.ts/' tsconfig.json`,
  ],
  [
    "an in-place sed whose s/// turns a quoted glob into a ** glob",
    String.raw`sed -i '' 's/"src\/\*"/"src\/**\/*"/' tsconfig.json`,
  ],
  [
    "an in-place sed whose s/// writes a trailing ** glob",
    String.raw`sed -i '' 's/a/dist\/**/' .gitignore`,
  ],
  [
    "an in-place sed whose s/// writes a relative glob of two parts",
    String.raw`sed -i '' 's/a/packages\/*\/*/' package.json`,
  ],
  [
    "an in-place sed whose s/// writes a regex then a glob after a relative folder",
    String.raw`sed -i '' 's/a/x\/.*\/*/' notes.md`,
  ],
  [
    "an in-place sed whose s/// writes two groups between slashes",
    String.raw`sed -i '' 's/\(a\)\(b\)/x\/\1\/\2\/y/' notes.md`,
  ],
  [
    "an in-place sed whose s/// writes its match twice after slashes",
    String.raw`sed -i '' 's/a/\/&\/&/' notes.md`,
  ],
  [
    "an in-place sed whose s||| writes a path outside the root",
    `sed -i '' 's|a|ls ~/work/x|' run.sh`,
  ],
  [
    "an in-place sed by BSD's -I whose s/// writes a path outside the root",
    String.raw`sed -I '' 's/a/ls ~\/work\/x/' run.sh`,
  ],
  [
    "an in-place sed of an ordinary regex on a file in the session's scratch",
    `sed -i '' 's/a*b/c/' ${DATA}/scratch/w/a.txt`,
  ],
  [
    "an in-place sed whose s/// writes a glob outside the root into a git hook",
    String.raw`sed -i '' 's/a/ls ~\/work\/*.ts/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a path in the scratch into a git hook",
    String.raw`sed -i '' 's/a/ls ~\/.playground\/scratch\/w/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose /regex/d holds an absolute path and a glob",
    String.raw`sed -i '' '/\/tmp\/.*\.log/d' run.sh`,
  ],
  [
    "an in-place sed whose s/// pattern names the root and writes a plain word",
    String.raw`sed -i '' 's/~\/.play*\/extensions/x/' run.sh`,
  ],
  ["an in-place sed whose s/// writes the text its & matched", `sed -i '' 's/a.*/[&]/' run.sh`],
  [
    "an in-place sed whose s/// writes a regex in slashes holding an escaped *",
    String.raw`sed -i '' 's/a/awk '"'"'\/\\\\*\/'"'"'/' run.sh`,
  ],
  [
    "an in-place sed whose s/// writes the home's name and a path in the scratch",
    String.raw`sed -i '' 's/a/$HOME:h modifiers, ~\/.playground\/handoffs\/x.md/' notes.md`,
  ],
]

export const groups: Group[] = [
  { folders: ["home", "process worktree"], guards: ["no-extensions-write"], rows },
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: (paths) =>
      rows(paths).map(([what, call, folder]): Row => [
        `${what}${WHOLE}`,
        `sleep 1; ${call}`,
        folder,
      ]),
  },
]

const allowedCalls = [
  "an in-place sed whose a\\ text writes plain words",
  "an in-place sed whose a\\ text writes plain words after a space",
  "an in-place sed whose i\\ text writes a shebang",
  "an in-place sed whose a\\ text writes a relative glob",
  "an in-place sed whose c\\ text writes a glob outside the root",
  "an in-place sed whose s/// writes a relative ** glob after ..",
  "an in-place sed whose s/// writes a relative glob after two ..",
  "an in-place sed whose s/// writes a relative ** glob",
  "an in-place sed whose s/// turns a quoted glob into a ** glob",
  "an in-place sed whose s/// writes a trailing ** glob",
  "an in-place sed whose s/// writes a relative glob of two parts",
  "an in-place sed whose s/// writes a regex then a glob after a relative folder",
  "an in-place sed whose s/// writes two groups between slashes",
  "an in-place sed whose s/// writes its match twice after slashes",
  "an in-place sed whose s||| writes a path outside the root",
  "an in-place sed by BSD's -I whose s/// writes a path outside the root",
  "an in-place sed of an ordinary regex on a file in the session's scratch",
  "an in-place sed whose s/// writes a glob outside the root into a git hook",
  "an in-place sed whose s/// writes a path in the scratch into a git hook",
  "an in-place sed whose /regex/d holds an absolute path and a glob",
  "an in-place sed whose s/// pattern names the root and writes a plain word",
  "an in-place sed whose s/// writes the text its & matched",
  "an in-place sed whose s/// writes a regex in slashes holding an escaped *",
  "an in-place sed whose s/// writes the home's name and a path in the scratch",
]

export const allowed: string[] = [...allowedCalls, ...allowedCalls.map((what) => `${what}${WHOLE}`)]

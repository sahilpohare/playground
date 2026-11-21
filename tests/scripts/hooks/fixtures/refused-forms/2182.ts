import type { Group, Paths, Row } from "./_shared"

// #2182: an in-place sed or perl edit whose file comes from a value the hook does not hold, a substitution or a variable it never saw set, could edit a file in the root, while cp and tee given the same value were refused; each row also runs after a sleep, on a line read whole; rows are data, as refused-forms.ts says.
const WHOLE = ", on a line read whole"
const rows = ({ ROOT }: Paths): Row[] => [
  [
    "an in-place sed on a file from a substitution",
    `sed -i '' 's/a/b/' $(echo ${ROOT}/policy.json)`,
  ],
  [
    "an in-place sed on a file from a quoted substitution",
    `sed -i '' 's/a/b/' "$(echo ${ROOT}/policy.json)"`,
  ],
  [
    "an in-place sed on a file from a backtick substitution",
    `sed -i '' 's/a/b/' \`echo ${ROOT}/policy.json\``,
  ],
  ["an in-place sed on a quoted variable the hook does not hold", `sed -i '' 's/a/b/' "$X"`],
  ["an in-place sed on a variable the hook does not hold", `sed -i '' 's/a/b/' $X`],
  ["an in-place sed on files from a substitution reading a list", `sed -i '' 's/a/b/' $(cat list)`],
  [
    "an in-place perl edit on a file from a substitution",
    `perl -pi -e 's/a/b/' $(echo ${ROOT}/policy.json)`,
  ],
  ["an in-place perl edit on a variable the hook does not hold", `perl -pi -e 's/a/b/' "$X"`],
  ["an in-place sed on a variable the call holds", `X=notes.md; sed -i '' 's/a/b/' "$X"`],
  ["a sed that prints a file from a substitution", `sed -n 's/a/b/p' $(echo notes.md)`],
]

export const groups: Group[] = [
  { folders: ["home", "data folder", "process worktree"], guards: ["no-extensions-write"], rows },
  {
    folders: ["home", "data folder", "process worktree"],
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
  "an in-place sed on a variable the call holds",
  "a sed that prints a file from a substitution",
]

export const allowed: string[] = [...allowedCalls, ...allowedCalls.map((what) => `${what}${WHOLE}`)]

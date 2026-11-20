import type { Group, Paths, Row } from "./_shared"

// #2187: a sed's or perl's script whose written text spells the root behind escaped slashes, a perl -pi replacement that spells it by a glob, and an in-place sed replacement naming a folder between the home and the root, which holds it; each row also runs after a sleep, on a line read whole; rows are data, as refused-forms.ts says.
const WHOLE = ", on a line read whole"
const rows = ({ HOME }: Paths): Row[] => [
  [
    "a read-only sed whose s/// writes the root behind escaped slashes into a git hook by tee",
    String.raw`sed -n 's/a/touch ~\/.playground\/extensions\/x/p' run.sh | tee .git/hooks/pre-commit`,
  ],
  [
    "a read-only sed whose s/// writes the root behind escaped slashes into a git hook by a redirect",
    String.raw`sed -n 's/a/touch ~\/.playground\/extensions\/x/p' run.sh > .git/hooks/pre-commit`,
  ],
  [
    "a sed whose s/// prints the root behind escaped slashes",
    String.raw`sed 's/a/touch ~\/.playground\/extensions\/x/' run.sh`,
  ],
  [
    "a sed off the read grammar whose script spells the root behind escaped slashes",
    String.raw`sed -n 's/a/touch ~\/.playground\/extensions\/x/w out.txt' run.sh`,
  ],
  [
    "an in-place perl whose s/// writes the root behind escaped slashes into a git hook",
    String.raw`perl -pi -e 's/a/touch ~\/.playground\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl by -i -pe whose s/// writes the root behind escaped slashes",
    String.raw`perl -i -pe 's/a/touch ~\/.playground\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "a read-only perl whose s/// writes the root behind escaped slashes into a git hook",
    String.raw`perl -pe 's/a/touch ~\/.playground\/extensions\/x/' run.sh > .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s||| writes a glob of the root into a git hook",
    `perl -pi -e 's|a|touch ~/.play*/extensions/x|' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s### writes a glob of the root into a git hook",
    `perl -pi -e 's#a#touch ~/.play*/extensions/x#' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// writes a glob of the root behind escaped slashes",
    String.raw`perl -pi -e 's/a/touch ~\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// writes a glob of the root under $HOME",
    String.raw`perl -pi -e 's/a/touch $HOME\/.play*\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// spells the root by a group it matched, read by \\1",
    String.raw`perl -pi -e 's/^(.*)$/touch ~\/.play\1\/extensions\/x/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the data folder that holds the root",
    String.raw`sed -i '' 's/a/rm ~\/.p*/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a dot glob of the home that matches the data folder",
    String.raw`sed -i '' 's/a/rm ~\/.*/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the data folder that holds the root",
    String.raw`sed -i '' 's/a/rm ~\/.playground/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the data folder with a trailing slash",
    String.raw`sed -i '' 's/a/rm ~\/.playground\//' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the data folder as a brace list's first part",
    String.raw`sed -i '' 's/a/rm ~\/{.playground,x}/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the data folder as a brace list's later part",
    String.raw`sed -i '' 's/a/rm ~\/{x,.playground}/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a glob of the data folder in a brace list",
    String.raw`sed -i '' 's/a/rm ~\/{.p*,x}/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes the data folder in a zsh (…) group",
    String.raw`sed -i '' 's/a/rm ~\/(.playground|x)/' .git/hooks/pre-commit`,
  ],
  [
    "an in-place sed whose s/// writes a ** glob of the absolute home",
    `sed -i '' 's/a/ls ${HOME.replaceAll("/", "\\/")}\\/**/' .git/hooks/pre-commit`,
    "home",
  ],
  [
    "an in-place sed whose s/// writes a ** glob of the home in a brace list",
    String.raw`sed -i '' 's/a/ls ~\/{**,x}/' .git/hooks/pre-commit`,
    "home",
  ],
  [
    "an in-place sed whose c\\ text writes a glob of the root",
    "sed -i '' '1c\\\ntouch ~/.play*/extensions/x' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed whose c\\ text writes the root's path",
    "sed -i '' '1c\\\ntouch ~/.playground/extensions/x' .git/hooks/pre-commit",
  ],
  [
    "an in-place sed whose s/// writes a glob of the root in a brace list's first part",
    String.raw`sed -i '' 's/a/touch {~\/.play*\/extensions,x}/' .git/hooks/pre-commit`,
  ],
  [
    "a read-only sed whose s||| prints the root's path",
    `sed -n 's|a|touch ~/.playground/extensions/x|p' run.sh | tee .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s### writes the root's path",
    `perl -pi -e 's#a#touch ~/.playground/extensions/x#' .git/hooks/pre-commit`,
  ],
  [
    "a read-only sed whose regex address names the root behind escaped slashes",
    String.raw`sed -n '/\/.playground\/extensions/p' notes.md`,
  ],
  [
    "a read-only sed whose s/// pattern names the root behind escaped slashes",
    String.raw`sed -n 's/\/.playground\/extensions/x/p' notes.md`,
  ],
  [
    "a read-only perl whose regex names the root behind escaped slashes",
    String.raw`perl -ne 'print if /\/.playground\/extensions/' notes.md`,
  ],
  [
    "an in-place perl whose s/// pattern names the root behind escaped slashes",
    String.raw`perl -pi -e 's/\/.playground\/extensions/x/' notes.md`,
  ],
  [
    "a read-only sed whose s/// writes a path outside the root into a git hook",
    String.raw`sed -n 's/a/\/tmp\/x/p' run.sh | tee .git/hooks/pre-commit`,
  ],
  [
    "an in-place perl whose s/// writes a path outside the root into a git hook",
    String.raw`perl -pi -e 's/a/~\/work\/x/' .git/hooks/pre-commit`,
  ],
  ["an in-place perl whose s/// renames a word", `perl -pi -e 's/foo/bar/g' notes.md`],
  ["an in-place perl whose s/// trims trailing space", String.raw`perl -pi -e 's/\s+$//' notes.md`],
  [
    "an in-place perl whose s/// writes a relative glob",
    String.raw`perl -pi -e 's/a/..\/src\/*.ts/' tsconfig.json`,
  ],
  [
    "an in-place perl whose s/// writes a path under /usr",
    String.raw`perl -pi -e 's/a/\/usr\/local\/bin/' run.sh`,
  ],
  ["an in-place perl whose s||| renames a word", `perl -pi -e 's|a|b|g' notes.md`],
  [
    "an in-place perl whose s### writes a path outside the root",
    `perl -pi -e 's#/usr/local#/opt#' run.sh`,
  ],
  [
    "an in-place sed whose s/// writes a folder beside the root",
    String.raw`sed -i '' 's/a/rm ~\/.playground\/scratch\/w/' run.sh`,
  ],
  [
    "an in-place sed whose s/// writes another folder of the data folder",
    String.raw`sed -i '' 's/a/ls ~\/.playground\/handoffs/' .git/hooks/pre-commit`,
  ],
  ["an in-place sed whose s/// writes the home itself", String.raw`sed -i '' 's/a/cd ~/' run.sh`],
  [
    "an in-place sed whose s/// writes a folder of the home",
    String.raw`sed -i '' 's/a/ls ~\/work/' run.sh`,
  ],
  ["an in-place sed whose s/// writes a lone slash", String.raw`sed -i '' 's/a/x \/ y/' notes.md`],
  [
    "an in-place perl whose s/// writes its group by \\1",
    String.raw`perl -pi -e 's/a/\1b/' notes.md`,
  ],
  [
    "an in-place sed whose s/// writes a brace list of plain names under the home",
    String.raw`sed -i '' 's/a/ls ~\/{a,b}/' notes.md`,
  ],
  [
    "an in-place sed whose s/// writes a * glob of the home, which no dot name matches",
    String.raw`sed -i '' 's/a/ls ~\/*/' notes.md`,
  ],
  [
    "an in-place sed whose s/// writes a path under /usr",
    String.raw`sed -i '' 's/a/\/usr\/local\/bin/' run.sh`,
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

// #2245 refuses any remover written into a hook, so each control here that writes one edits run.sh, a script a shell may run later, which the in-place reading judges as it judges a hook
const allowedCalls = [
  "a read-only sed whose regex address names the root behind escaped slashes",
  "a read-only sed whose s/// pattern names the root behind escaped slashes",
  "a read-only perl whose regex names the root behind escaped slashes",
  "an in-place perl whose s/// pattern names the root behind escaped slashes",
  "a read-only sed whose s/// writes a path outside the root into a git hook",
  "an in-place perl whose s/// writes a path outside the root into a git hook",
  "an in-place perl whose s/// renames a word",
  "an in-place perl whose s/// trims trailing space",
  "an in-place perl whose s/// writes a relative glob",
  "an in-place perl whose s/// writes a path under /usr",
  "an in-place perl whose s||| renames a word",
  "an in-place perl whose s### writes a path outside the root",
  "an in-place sed whose s/// writes a folder beside the root",
  "an in-place sed whose s/// writes another folder of the data folder",
  "an in-place sed whose s/// writes the home itself",
  "an in-place sed whose s/// writes a folder of the home",
  "an in-place sed whose s/// writes a lone slash",
  "an in-place perl whose s/// writes its group by \\1",
  "an in-place sed whose s/// writes a brace list of plain names under the home",
  "an in-place sed whose s/// writes a * glob of the home, which no dot name matches",
  "an in-place sed whose s/// writes a path under /usr",
]

// a read-only perl's regex on a line read whole is text canary already judges as the line's, so only its call-by-call twin is allowed
const WHOLE_REFUSED = "a read-only perl whose regex names the root behind escaped slashes"
export const allowed: string[] = [
  ...allowedCalls,
  ...allowedCalls.filter((what) => what !== WHOLE_REFUSED).map((what) => `${what}${WHOLE}`),
]

import type { Group } from "./_shared"

// #2094: after a cd the hook cannot read, xargs hands a program on neither the removers' nor the writers' list (an in-place sed or perl edit, chmod, truncate, shred, git rm, mktemp, sort -o, curl -o) the files it writes from stdin, which unreadCdWrites read from the typed words alone; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "process worktree"],
    guards: ["no-extensions-write"],
    rows: () => [
      [
        "an in-place sed under xargs fed by grep after a cd to a variable",
        `cd "$X" && grep -l a f | xargs sed -i s/a/b/`,
      ],
      [
        "an in-place sed with an empty suffix under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs sed -i '' s/a/b/`,
      ],
      [
        "an in-place sed with an attached suffix under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs sed -i.bak s/a/b/`,
      ],
      [
        "an in-place sed with -e under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs sed -i -e s/a/b/`,
      ],
      [
        "sed --in-place under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs sed --in-place s/a/b/`,
      ],
      [
        "GNU sed in place under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs gsed -i s/a/b/`,
      ],
      [
        "an in-place sed under xargs -n1 after a cd to a variable",
        `cd "$X" && grep -l a f | xargs -n1 sed -i s/a/b/`,
      ],
      [
        "an in-place sed under xargs fed a relative name after a cd to a variable",
        `cd "$X" && echo f | xargs sed -i s/a/b/`,
      ],
      [
        "an in-place sed under xargs fed by find after a cd to a variable",
        `cd "$X" && find . -name f | xargs sed -i s/a/b/`,
      ],
      [
        "an in-place sed under xargs after a cd to a substitution",
        `cd "$(cat p)" && grep -l a f | xargs sed -i s/a/b/`,
      ],
      [
        "perl -pi under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs perl -pi -e s/a/b/`,
      ],
      [
        "perl -i -pe under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs perl -i -pe s/a/b/`,
      ],
      ["chmod under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs chmod +x`],
      [
        "truncate under xargs after a cd to a variable",
        `cd "$X" && grep -l a f | xargs truncate -s 0`,
      ],
      ["shred under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs shred -u`],
      ["git rm under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs git rm`],
      ["mktemp under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs mktemp`],
      ["sort -o under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs sort -o`],
      ["curl -o under xargs after a cd to a variable", `cd "$X" && grep -l a f | xargs curl -o`],
      [
        "chmod under xargs fed stdin the hook cannot see after a cd to a variable",
        `cd "$X"; xargs chmod 644 /tmp/p`,
      ],
    ],
  },
]

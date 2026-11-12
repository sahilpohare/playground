import { type Group } from "./_shared"

// The forms the review of this file's source found refused; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "data folder"],
    guards: ["no-extensions-write"],
    rows: ({ ROOT }) => [
      ["a quiet commit whose -m message holds a parenthesised scope", `git commit -m "fix(x): y"`],
      [
        "a quiet commit whose -am message holds a parenthesised scope",
        `git commit -am "fix(x): y"`,
      ],
      [
        "a quiet commit whose --message= holds a parenthesised scope",
        `git commit --message="fix(x): y"`,
      ],
      ["git config set in the call before a quiet message", `git -c x.y=z commit -m "fix(x): y"`],
      ["a runner on the line after a quiet commit", `git commit -m "fix(x): y"; sh -c 'true'`],
      ["a redirect writing a file after a quiet commit", `git commit -m "fix(x): y" > f`],
      ["a quiet message on a commit git -C moves", `git -C /tmp commit -m "fix(x): y"`],
      ["a globbing file name after -F, not a held message", `git commit -F "my(x) file"`],
      ["a quiet message that holds the root's path as text", `git commit -m "see ${ROOT} now"`],
      [
        "a quiet message that names a gated call",
        `git commit -m "docs: the hook refuses playground ext sync now"`,
      ],
      ["a quiet message on a git sudo runs", `sudo git commit -m "fix(x): y"`],
      ["a quiet message on a git env runs", `env git commit -m "fix(x): y"`],
      ["a quiet message on a git xargs runs", `xargs git commit -m "fix(x): y"`],
      ["a quiet message on a git nice runs with an option", `nice -n 5 git commit -m "fix(x): y"`],
      ["a quiet message on a git command runs", `command git commit -m "fix(x): y"`],
      ["a quiet message on a git in this folder", `./git commit -m "fix(x): y"`],
      ["a quiet message on a git in a folder of the home", `~/bin/git commit -m "fix(x): y"`],
      ["a quiet message on a git outside the system folders", `/tmp/x/git commit -m "fix(x): y"`],
    ],
  },
]

export const allowed: string[] = [
  "a quiet commit whose -m message holds a parenthesised scope",
  "a quiet commit whose -am message holds a parenthesised scope",
  "a quiet commit whose --message= holds a parenthesised scope",
  // #1455: a quiet message is text git never runs, so one naming a gated call runs
  "a quiet message that names a gated call",
  // #1799: a quiet commit's own redirect takes only what git prints, judged by where it writes, so it keeps the line call by call
  "a redirect writing a file after a quiet commit",
]

import { type Group } from "./_shared"

// #2004: a commit in a clone of a guarded extension repository changes only the clone, so it passes on a branch the push rule lets through, and every commit that may land on the default, or whose HEAD or git folder the call may move, stays refused; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["extension clone"],
    guards: ["no-extension-repo-write"],
    rows: () => [
      ["a commit on the default branch", "git commit -m x"],
      ["a commit -a on the default branch", "git commit -a -m x"],
      [
        "a commit after a switch to a new branch in the call",
        "git switch -c feature && git commit -m x",
      ],
    ],
  },
  {
    folders: ["extension clone on a branch"],
    guards: ["no-extension-repo-write"],
    rows: () => [
      ["a commit on a branch other than the default", "git commit -m x"],
      ["a commit with -c on a branch", "git -c user.name=x commit -m x"],
      ["a commit with a GIT_ variable on a branch", "GIT_DIR=.git git commit -m x"],
      ["a commit after a switch to the default in the call", "git switch main && git commit -m x"],
    ],
  },
]

export const allowed: string[] = ["a commit on a branch other than the default"]

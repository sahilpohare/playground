import { type Group } from "./_shared"

// #1326: git takes its repository and work tree from GIT_DIR and GIT_WORK_TREE too, set for the one call, through env, or exported earlier on the line, so each names the tree a git move acts on as --git-dir and --work-tree do; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      ["a commit by a GIT_DIR set for the call", `GIT_DIR=${MAIN}/.git git commit -m x`],
      ["a reset by a GIT_WORK_TREE set for the call", `GIT_WORK_TREE=${MAIN} git reset --hard`],
      ["a commit by a GIT_DIR set through env", `env GIT_DIR=${MAIN}/.git git commit -m x`],
      ["a checkout by a GIT_WORK_TREE set through env", `env GIT_WORK_TREE=${MAIN} git checkout .`],
      ["a commit by a GIT_DIR exported earlier", `export GIT_DIR=${MAIN}/.git; git commit -m x`],
      [
        "a reset by a GIT_WORK_TREE exported earlier",
        `export GIT_WORK_TREE=${MAIN} && git reset --hard`,
      ],
      ["a commit by a GIT_DIR the hook cannot read", 'GIT_DIR="$(cat dir)" git commit -m x'],
      [
        "a reset by a GIT_WORK_TREE the hook cannot read",
        'export GIT_WORK_TREE="$(cat dir)"; git reset --hard',
      ],
    ],
  },
]

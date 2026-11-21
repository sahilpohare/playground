import { type Group, type Row } from "./_shared"

// #2456: a variable of the session's starting environment (refused-forms.test.ts's STARTING) is read from it before a cd or -C target is judged, while one the line may set, one the shell keeps and one never set stay unread; rows are data, as refused-forms.ts says.
const G = " && gh api repos/acme-labs/demo/issues/1"

const extensionsControls = (): Row[] => [
  ["a cd to $PLAYGROUND_REPO before a gh read", `cd "$PLAYGROUND_REPO"${G}`],
  ["a cd to ${PLAYGROUND_REPO} before a gh read", `cd "\${PLAYGROUND_REPO}"${G}`],
  ["a cd to ${PLAYGROUND_REPO:?} before a gh read", `cd "\${PLAYGROUND_REPO:?}"${G}`],
  ["a cd to a starting $W before a gh read", `cd "$W"${G}`],
]

const repoControls = (): Row[] => [
  ["a push to a branch by -C $PLAYGROUND_REPO", 'git -C "$PLAYGROUND_REPO" push origin PG-1-x'],
  ["a push to a branch by -C ${PLAYGROUND_REPO}", 'git -C "${PLAYGROUND_REPO}" push origin PG-1-x'],
  [
    "a push to a branch by -C ${PLAYGROUND_REPO:?}",
    'git -C "${PLAYGROUND_REPO:?}" push origin PG-1-x',
  ],
  ["a push to a branch by -C a starting $W", 'git -C "$W" push origin PG-1-x'],
]

export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: () => [
      ...extensionsControls(),
      ["a cd to a starting variable naming the root", `cd "$ROOT_DIR"${G}`],
      ["a copy into the root through a starting variable", 'cp x "$ROOT_DIR/hooks/y"'],
      ["a cd to a variable never set", `cd "$NOT_SET"${G}`],
      [
        "a cd to a variable a prefix assignment sets",
        `PLAYGROUND_REPO=/x cd "$PLAYGROUND_REPO"${G}`,
      ],
      ["a cd to a variable an earlier command sets to the root", `W="$ROOT_DIR"; cd "$W"${G}`],
      ["a cd to a variable an earlier command sets by a substitution", `W=$(cat f); cd "$W"${G}`],
      ["a cd to a variable export sets", `export W=$X; cd "$W"${G}`],
      ["a cd to a variable declare sets", `declare W=$X; cd "$W"${G}`],
      ["a cd to a variable read sets", `read W; cd "$W"${G}`],
      ["a cd to a for loop's variable", `for W in a; do cd "$W"${G}; done`],
      ["a cd to a variable after eval", `eval "$X"; cd "$W"${G}`],
      ["a cd to a variable after source", `source ./f; cd "$W"${G}`],
      ["a cd to a variable after .", `. ./f; cd "$W"${G}`],
      ["a cd to a variable typeset -g sets", `typeset -g W=$X; cd "$W"${G}`],
      ["a cd to a variable integer sets", `integer W; cd "$W"${G}`],
      ["a cd to a variable float sets", `float W; cd "$W"${G}`],
      ["a cd to a variable vared sets", `vared W; cd "$W"${G}`],
      ["a cd to a variable zparseopts sets", `zparseopts -A W; cd "$W"${G}`],
      ["a cd to a variable read -A sets", `read -A W; cd "$W"${G}`],
      [
        "a cd to a variable declare sets by a name read from stdin",
        `read n; declare "$n=/x"; cd "$W"${G}`,
      ],
      [
        "a cd to a variable printf -v sets by a name read from stdin",
        `read n; printf -v "$n" /x; cd "$W"${G}`,
      ],
      ["a cd to a variable bash's indirect name sets", `read n; : \${!n}; cd "$W"${G}`],
      ["a cd to a variable zsh's indirect name sets", `read n; : \${(P)n::=/x}; cd "$W"${G}`],
      ["a cd to a variable its own default assigns", `cd "\${W:=/x}"${G}`],
      ["a cd to Claude Code's hook-only variable", `cd "$CLAUDE_PROJECT_DIR"${G}`],
      ["a cd to OLDPWD, which the shell keeps", `cd "$OLDPWD"${G}`],
      ["a cd to zsh's own path array", `cd "$path"${G}`],
      ["a cd to PWD after a cd, which the shell keeps", `cd "$W" && cd "$PWD"${G}`],
      ["a cd to a variable after an if's .", `if . ./f; then cd "$W"${G}; fi`],
      ["a cd to a variable after a while's .", `while . ./f; do cd "$W"${G}; break; done`],
      ["a cd to a variable after builtin .", `builtin . ./f; cd "$W"${G}`],
      ["a cd to a variable after command .", `command . ./f; cd "$W"${G}`],
      ["a cd to a variable after ! .", `! . ./f; cd "$W"${G}`],
      ["a cd to a variable after time .", `time . ./f; cd "$W"${G}`],
      ["a cd to a variable after a source split by quotes", `so''urce ./f; cd "$W"${G}`],
      ["a cd to a variable after a source split by a backslash", `so\\urce ./f; cd "$W"${G}`],
      [
        "a cd to a variable zstyle -s sets by a name read from stdin",
        `read n; zstyle :x y /x; zstyle -s :x y "$n"; cd "$W"${G}`,
      ],
      [
        "a cd to a variable getln sets by a name read from stdin",
        `read n; print -z /x; getln "$n"; cd "$W"${G}`,
      ],
      ["a cd to FPATH after read -A sets its tied fpath", `read -A fpath; cd "$FPATH"${G}`],
      ["a cd to MANPATH after read -A sets its tied manpath", `read -A manpath; cd "$MANPATH"${G}`],
      [
        "a cd to MODULE_PATH after read -A sets its tied module_path",
        `read -A module_path; cd "$MODULE_PATH"${G}`,
      ],
    ],
  },
  {
    folders: ["checkout"],
    guards: ["no-extension-repo-write"],
    rows: () => [
      ...repoControls(),
      [
        "a push to the default branch by -C a starting variable",
        'git -C "$EXT_DIR" push origin main',
      ],
      ["a push by -C a variable never set", 'git -C "$NOT_SET" push origin PG-1-x'],
      [
        "a push by -C a variable an earlier command sets",
        'W=$(cat f); git -C "$W" push origin PG-1-x',
      ],
      ["a push by -C a variable a prefix assignment sets", 'W=/x git -C "$W" push origin PG-1-x'],
      [
        "a push by -C a variable after an if's .",
        'if . ./f; then git -C "$W" push origin PG-1-x; fi',
      ],
      [
        "a push by -C a variable after builtin and a source split by quotes",
        "builtin so''urce ./f; git -C \"$W\" push origin PG-1-x",
      ],
      [
        "a push by -C a variable read sets by a name split by quotes",
        "read PLAYGROUND_RE''PO; git -C \"$PLAYGROUND_REPO\" push origin PG-1-x",
      ],
      [
        "a push by -C a variable declare sets by a name split by quotes",
        "declare PLAYGROUND_RE''PO=/x; git -C \"$PLAYGROUND_REPO\" push origin PG-1-x",
      ],
    ],
  },
]

export const allowed: string[] = [...extensionsControls(), ...repoControls()].map(([what]) => what)

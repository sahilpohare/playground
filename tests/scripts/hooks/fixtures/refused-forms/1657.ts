import { type Group, NEVER_MADE } from "./_shared"

// #1657: a read-only sed -n under bash -c, a read line ending in date, and an awk with a plain getline, which no-extensions-write read whole and so took a sed address or an awk pattern as a path, beside the forms that write, run or run a substitution's text, which it still refuses; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["home", "data folder", "tmp", "checkout"],
    guards: ["no-extensions-write"],
    rows: ({ LIST }) => [
      [
        "a read-only sed -n brace range under bash -c",
        `/bin/bash -c 'sed -n "/^switch_ends() {/,/^}/p" notes.sh'`,
      ],
      [
        "a gh read piped through sed -n with brackets and head, then date",
        "gh api repos/acme/widgets/issues/comments/1 --jq .body | sed -n '/Findings\\|\\[blocking\\]\\|\\[should-fix\\]\\|\\[nit\\]/,+3p' | head -60; date -u +%FT%TZ",
      ],
      [
        "an awk with a plain getline after a slashed pattern",
        "awk '/-->/{getline; print}' notes.md",
      ],
      ["an eval of a sed -n read's output", `eval "$(sed -n "/^switch_ends() {/,/^}/p" notes.sh)"`],
      [
        "an eval of a sed -n read's output under bash -c",
        `/bin/bash -c 'eval "$(sed -n "/^switch_ends() {/,/^}/p" notes.sh)"'`,
      ],
      ["a sed -i on the guarded folder under bash -c", `/bin/bash -c 'sed -i s/a/b/ ${LIST}'`],
      [
        "a sed w command into the guarded folder under bash -c",
        `/bin/bash -c "sed -n 'w ${LIST}' notes.sh"`,
      ],
      ["a sed -i on the guarded folder, then date", `sed -i s/a/b/ ${LIST}; date`],
      [
        "an awk getline line that prints into the guarded folder",
        `awk '{getline; print > "${LIST}"}' notes.md`,
      ],
      [
        "an awk getline line that calls system",
        `awk '{getline; system("rm -rf ${NEVER_MADE}")}' notes.md`,
      ],
      ["an awk getline from a command", `awk '{"rm -rf ${NEVER_MADE}" | getline; print}' notes.md`],
      [
        "a bash -c of a read beside a removal",
        `/bin/bash -c 'sed -n "/{/p" notes.sh'; rm -rf ${NEVER_MADE}`,
      ],
    ],
  },
]

export const allowed: string[] = [
  "a read-only sed -n brace range under bash -c",
  "a gh read piped through sed -n with brackets and head, then date",
  "an awk with a plain getline after a slashed pattern",
]

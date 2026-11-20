import { type Group, NEVER_MADE } from "./_shared"

// #1887: five calls that write nothing either guard keeps, each refused before because a word that is text (a perl edit's script, a browser eval's script, a commit message, a jq filter) was read as a shell line, beside the forms of the same programs that still write into the root or run a shell; rows are data, as refused-forms.ts says.
const PORTAL = `document.querySelector("nextjs-portal")?.shadowRoot?.querySelector("[data-issues-count]")?.textContent ?? "0"`
const RUNS = `'[.workflow_runs[] | "\\(.name)=\\(.status)/\\(.conclusion // "-")"] | join(" ")'`

export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-extensions-write"],
    rows: ({ LIST, ROOT, WORK }) => [
      [
        "an in-place perl edit whose replacement holds a parenthesised conditional",
        `perl -pi -e 's/\\(line\\.prepare \\? prepareLine\\(id, relay\\) : ""\\)/(line.prepare ? prepareLine(id, relay, session, ctx.repo) : "")/' start.ts`,
      ],
      ["an in-place perl edit of a file in the root", `perl -pi -e 's/a/b/' ${LIST}`],
      [
        "an in-place perl edit whose script runs a command",
        `perl -pi -e 'system("touch ${LIST}")' start.ts`,
      ],
      [
        "a browser eval holding the nullish operator beside another command",
        `sleep 1; agent-browser --session t eval '${PORTAL}'`,
        "home",
      ],
      [
        "a browser eval naming the root beside another command",
        `sleep 1; agent-browser --session t eval 'fetch("${ROOT}/policy.json")'`,
      ],
      [
        "a commit by -C to its own folder whose message holds a folder change, a build and an or-true",
        `git -C ~/x/.claude/worktrees/y commit -q -m "fix: x" -m "a line like\ncd && make || true, then . ./env"`,
        "process worktree",
      ],
      [
        "a commit by -C to another folder whose message holds a folder change",
        `git -C /tmp commit -q -m "fix: x" -m "a line like\ncd && make || true, then . ./env"`,
        "process worktree",
      ],
      [
        "a commit by -C into a clone in the root whose message holds a folder change",
        `git -C ${ROOT} commit -q -m "fix: x" -m "a line like\ncd && make || true, then . ./env"`,
      ],
      [
        "a commit by -c whose message holds a folder change into the root",
        `git -c core.hooksPath=/tmp -C ${WORK}/playground commit -q -m "fix: x" -m "a line like\ncd ${ROOT} && touch x"`,
      ],
      [
        "a read-only gh call in a loop whose jq filter holds a parenthesised alternative",
        `for p in 1 2; do gh api repos/o/r/actions/runs --jq ${RUNS}; done`,
      ],
      [
        "a gh call in a loop whose jq output a shell runs",
        `for p in 1 2; do gh api repos/o/r/actions/runs --jq '"rm -rf ${NEVER_MADE}"' | sh; done`,
      ],
    ],
  },
  {
    folders: ["checkout", "process home"],
    guards: ["no-raw-delete"],
    rows: () => [
      [
        "a browser eval by session holding optional chaining and the nullish operator",
        `agent-browser --session t eval '${PORTAL}'`,
      ],
      [
        "a browser eval with another option holding optional chaining and the nullish operator",
        `agent-browser --headed eval '${PORTAL}'`,
      ],
      [
        "a browser eval by session behind sudo holding optional chaining and the nullish operator",
        `sudo agent-browser --session t eval '${PORTAL}'`,
      ],
    ],
  },
]

export const allowed: string[] = [
  "an in-place perl edit whose replacement holds a parenthesised conditional",
  "a browser eval holding the nullish operator beside another command",
  "a commit by -C to its own folder whose message holds a folder change, a build and an or-true",
  "a read-only gh call in a loop whose jq filter holds a parenthesised alternative",
  "a browser eval by session holding optional chaining and the nullish operator",
]

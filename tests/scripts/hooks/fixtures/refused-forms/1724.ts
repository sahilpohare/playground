import { type Group } from "./_shared"

// #1724: an agent-browser screenshot or pdf saves a relative path in the folder its browser started in, the main checkout included, so each takes an absolute path under a scratchpad or a worktree; rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout", "home"],
    guards: ["no-main-checkout"],
    rows: ({ MAIN }) => [
      ["a screenshot to a relative path", "agent-browser screenshot shot.png"],
      ["a screenshot with no path", "agent-browser screenshot"],
      [
        "a full-page screenshot to a relative path after the session",
        "agent-browser --session s screenshot --full shots/page.png",
      ],
      ["a screenshot of an element with no path", "agent-browser screenshot @e1"],
      ["a pdf to a relative path", "agent-browser pdf page.pdf"],
      ["a pdf with no path", "agent-browser pdf"],
      [
        "a screenshot to a scratchpad's absolute path",
        "agent-browser --session s screenshot --full /private/tmp/claude-501/scratchpad/shot.png",
      ],
      [
        "a pdf to a worktree's absolute path",
        `agent-browser pdf ${MAIN}/.claude/worktrees/a/page.pdf`,
      ],
    ],
  },
]

export const allowed: string[] = [
  "a screenshot to a scratchpad's absolute path",
  "a pdf to a worktree's absolute path",
]

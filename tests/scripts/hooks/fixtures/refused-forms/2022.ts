import type { Group } from "./_shared"

// #2022: main and canary of the factory's repository move only through pr:merge, merge-on-ready and the ship step, so a hand-run merge, a gh api write to either branch, a GraphQL mutation that merges or moves a ref, and a GitHub tool's write there are refused for a worker; the ship step's tag and a write to another branch run. Rows are data, as refused-forms.ts says.
export const groups: Group[] = [
  {
    folders: ["checkout"],
    guards: ["no-protected-push"],
    rows: () => [
      ["a hand-run merge", "gh pr merge 5 --squash --match-head-commit 0123abc"],
      ["a hand-run merge by -R", "gh pr merge 5 -R acme-labs/demo"],
      [
        "a ref update of main",
        "gh api -X PATCH repos/acme-labs/demo/git/refs/heads/main -f sha=abc1234",
      ],
      [
        "a ref create of canary",
        "gh api repos/acme-labs/demo/git/refs -f ref=refs/heads/canary -f sha=abc1234",
      ],
      [
        "a file write to main",
        "gh api -X PUT repos/acme-labs/demo/contents/x -f message=m -f content=Zg== -f branch=main",
      ],
      ["a pull request merge through gh api", "gh api -X PUT repos/acme-labs/demo/pulls/5/merge"],
      [
        "a GraphQL pull request merge",
        `gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }'`,
      ],
      [
        "a GitHub tool's merge",
        {
          input: { owner: "acme-labs", pullNumber: 5, repo: "demo" },
          tool: "mcp__github-shared__merge_pull_request",
        },
      ],
      [
        "a GitHub tool's push to canary",
        {
          input: { branch: "canary", files: [], message: "m", owner: "acme-labs", repo: "demo" },
          tool: "mcp__github-shared__push_files",
        },
      ],
      [
        "a GitHub tool's file write with no branch",
        {
          input: { content: "x", message: "m", owner: "acme-labs", path: "x", repo: "demo" },
          tool: "mcp__github-shared__create_or_update_file",
        },
      ],
      [
        "the ship step's tag",
        'gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/tags/v1.2.3 -f sha="$MERGE"',
      ],
      [
        "a ref update of a work branch",
        "gh api -X PATCH repos/acme-labs/demo/git/refs/heads/work -f sha=abc1234",
      ],
      ["a GraphQL read", "gh api graphql -f query='query { viewer { login } }'"],
    ],
  },
]

export const allowed: string[] = [
  "the ship step's tag",
  "a ref update of a work branch",
  "a GraphQL read",
]

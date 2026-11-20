import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const VERIFY = join(
  import.meta.dir,
  "../../../../../../extensions/core/skills/code-review-loop/references/VERIFY.md",
)

describe("VERIFY.md", () => {
  test("reads another PR's whole file list through the paginated read and the PR's own from the clone, since gh pr view stops at 100", async () => {
    const line =
      (await Bun.file(VERIFY).text())
        .split("\n")
        .find((l) => l.includes("**Read a whole file list.**")) ?? ""
    expect(line).toContain(
      "`gh api --paginate repos/<owner>/<repo>/pulls/<n>/files --jq '.[].filename'`",
    )
    expect(line).toContain("`git -C <clone> diff --name-only")
    expect(line).toContain("`gh pr view <n> --json files` stops at 100")
    expect(line).toContain("100 of its 143 files")
  })

  test("probes a guard PR's check() from a scratch script under --no-install, taking node_modules only when the hook fails to load (PG-1194)", async () => {
    const line =
      (await Bun.file(VERIFY).text())
        .split("\n")
        .find((l) => l.startsWith("- **Run the numbers.**")) ?? ""
    expect(line).toContain("For a guard PR (`scripts/hooks/`), probe its `check()` at once")
    expect(line).toContain("run with `bun --no-env-file --no-install <script>`")
    expect(line).toContain("auto-install would fetch whatever a bare import names from npm")
    expect(line).toContain(
      "A hook that fails to load under `--no-install` takes `node_modules` through run-slot's clone",
    )
    expect(line).toContain("To prove any other suspected logic bug, write a scratch test")
  })

  test("tells each sub-agent to make its scratch folder first and to write every probe output to an absolute path inside it (#415's out.txt in the main checkout)", async () => {
    const line =
      (await Bun.file(VERIFY).text())
        .split("\n")
        .find((l) =>
          l.startsWith("- **Give each code-review sub-agent its own scratch folder.**"),
        ) ?? ""
    expect(line).toContain(
      "Tell each sub-agent to make its folder (`mkdir -p <absolute path>`) before any command names it, and to write every probe output to an absolute path inside it",
    )
    expect(line).toContain(
      "**Done when** every measuring sub-agent's prompt names its folder by absolute path, with its `mkdir -p` and its absolute-output instruction",
    )
    expect(line).toContain(
      "inside the reviewer's, `~/.playground/scratch/<name>/std/` or `<name>/spec/`, and the reviewer's own probes go in a sibling of them, `<name>/probe/`",
    )
  })
})

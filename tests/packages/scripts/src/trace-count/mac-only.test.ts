import { describe, expect, test } from "bun:test"

import {
  count,
  type File,
  located,
  refusal,
  risen,
  risenKinds,
} from "../../../../../packages/scripts/src/trace-count/count"
import { macOnlyLines } from "../../../../../packages/scripts/src/trace-count/mac-only"

const at = (path: string, ...lines: string[]): File => ({ path, text: lines.join("\n") })

describe("macOnly", () => {
  test("a new unguarded call raises the count past its floor, and the refusal names its line and the fix", () => {
    const base = [at("scripts/a.sh", "#!/bin/bash", 'echo "ready"')]
    const floor = count(base)
    expect(floor.macOnly).toBe(0)
    const added = [...base, at("scripts/b.sh", "#!/bin/bash", "caffeinate -i sleep 5")]
    const over = risen(count(added), floor)
    expect(over).toEqual(["macOnly: 1 in the tree, counts.json allows 0"])
    const said = refusal(over, located(added, risenKinds(over)))
    expect(said).toContain("put a Linux branch in front of a Mac-only call")
    expect(said).toContain("scripts/b.sh:2: macOnly")
  })

  test("counts each program at a shell command's head and an argv's head", () => {
    const shell = at(
      "scripts/a.sh",
      "osascript -e 'beep'",
      "free=$(vm_stat | awk '{print $3}')",
      "x && sysctl -n hw.ncpu",
      "sudo pmset -g",
      "brew install jq",
      "cp -c a b",
    )
    expect(macOnlyLines(shell)).toEqual([0, 1, 2, 3, 4, 5])
    const code = at(
      "packages/a.ts",
      'Bun.spawnSync(["memory_pressure", "-Q"])',
      'const top = ["top", "-l", "1"]',
      'run(["open", "-a", "Docker"])',
      'Bun.which("launchctl")',
    )
    expect(macOnlyLines(code)).toEqual([0, 1, 2, 3])
  })

  test("counts an argv split over lines at its opening bracket's line", () => {
    const split = at(
      "packages/a.ts",
      "const answer = await ctx.run([",
      '  "sysctl",',
      '  "-n",',
      "  name,",
      "])",
    )
    expect(macOnlyLines(split)).toEqual([0])
  })

  test("a find-generic-password call does not count, since the Linux stand-in for security serves it", () => {
    const files = [
      at(
        "packages/a.ts",
        'const found = await run(["security", "find-generic-password", "-s", s, "-a", a, "-w"])',
      ),
      at("packages/b.ts", 'const out = security(["find-generic-password", "-s", service, "-w"])'),
      at("scripts/c.sh", 'tk="$(security find-generic-password -s "$S" -a "$A" -w)" || exit 1'),
    ]
    expect(count(files).macOnly).toBe(0)
  })

  test("a parameter named platform is no platform test", () => {
    const file = at(
      "packages/a.ts",
      "const read = (platform: NodeJS.Platform) => {",
      '  return run(["vm_stat"])',
      "}",
    )
    expect(macOnlyLines(file)).toEqual([1])
  })

  test("a trailing comment that names Linux guards nothing", () => {
    const files = [
      at("scripts/a.sh", "osascript -e beep # fails on linux"),
      at("packages/a.ts", 'run(["vm_stat"]) // no linux path yet'),
      at("scripts/b.py", 'run(["pmset", "-g"])  # darwin only'),
    ]
    expect(files.map((file) => macOnlyLines(file))).toEqual([[0], [0], [0]])
  })

  test("a call behind a Linux branch does not count", () => {
    const files = [
      at("packages/a.ts", 'const cmd = process.platform === "linux" ? ["free"] : ["vm_stat"]'),
      at(
        "packages/b.ts",
        'if (process.platform === "darwin") {',
        '  Bun.spawn(["caffeinate", "-i"])',
        "}",
      ),
      at(
        "scripts/c.sh",
        'case "$(uname)" in',
        "  Darwin)",
        "    osascript -e beep",
        "    ;;",
        "esac",
      ),
      at("scripts/d.sh", "mac() {", '  [ "$OS" = Darwin ] || return 1', "  brew install jq", "}"),
      at("scripts/e.py", 'if sys.platform == "darwin":', '    run(["pmset", "-g"])'),
    ]
    expect(count(files).macOnly).toBe(0)
  })

  test("a platform test at a file's top guards nothing below it", () => {
    const file = at("scripts/a.sh", 'OS="$(uname)"', "osascript -e beep")
    expect(macOnlyLines(file)).toEqual([1])
  })

  test("a comment, a message, a data row, a test and this count's own list do not count", () => {
    const files = [
      at(
        "scripts/a.sh",
        "# osascript -e beep",
        'echo "run osascript to beep"',
        "caffeinate|-d -i|keeps awake",
      ),
      at("packages/a.ts", '// Bun.spawn(["vm_stat"])', 'console.log("vm_stat is Mac-only")'),
      at("tests/a.test.ts", 'Bun.spawn(["vm_stat"])'),
      at("docs/a.md", "osascript -e beep"),
      at("packages/scripts/src/trace-count/mac-only.ts", '  ["vm_stat"],'),
    ]
    expect(count(files).macOnly).toBe(0)
  })
})

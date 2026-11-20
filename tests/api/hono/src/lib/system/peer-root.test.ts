import { afterAll, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runArgv } from "../../../../../../api/hono/src/lib/dashboard/run-argv"
import {
  PEER_STAGE,
  peerCopyArgv,
  peerInstallArgv,
  peerInstalledRefusal,
  peerOf,
  peerReadArgv,
  peerSecret,
  peerStepArgv,
  shQuote,
} from "../../../../../../api/hono/src/lib/system/peer-root"
import { SCRIPTS_DIR } from "../../../../../../api/hono/src/lib/system/root"
import {
  PEER_ACTION,
  PEER_INSTALL_TEXT,
  PEER_POLICY,
  PEER_RULE,
  ROOT_BASE,
  ROOT_DIR,
  ROOT_NAMES,
} from "../../../../../../packages/config/src/inbox"

const scratch = mkdtempSync(join(tmpdir(), "peer-root-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")
const PEER = { name: "spark-test", target: "me@spark-test" }
const MARKER = "pw-MARKER-7f3a'$(id)"
const GOOD = ROOT_NAMES.map((name) => ({ name, sha256: hash(`#!/bin/sh\necho ${name}\n`) }))

describe("a peer's names (PG-2434)", () => {
  test("its password's item is a playground- service, and a name that cannot be one is refused", () => {
    expect(peerSecret("spark-9dfb")).toBe("playground-spark-9dfb-sudo")
    expect(peerSecret("Spark-9DFB")).toBe("playground-spark-9dfb-sudo")
    expect(() => peerSecret("spark.local")).toThrow("has no name a secret store item can take")
  })

  test("a card names a machine org.cluster holds, never a host", () => {
    expect(peerOf("spark-test", [PEER])).toEqual(PEER)
    expect(() => peerOf("me@spark-test", [PEER])).toThrow("is not a machine")
    expect(() => peerOf("other", [PEER])).toThrow("other is not a machine this Dashboard reaches")
  })

  test("shQuote gives sh one word back, byte for byte", async () => {
    for (const text of ["plain", "it's", `a'b"c$(id)\`x\`\n$HOME\\`, PEER_INSTALL_TEXT]) {
      const ran = await runArgv(["/bin/sh", "-c", `printf %s ${shQuote(text)}`])
      expect(ran.out).toBe(text.trim())
    }
  })
})

describe("a peer's argv (PG-2434)", () => {
  test("ssh and scp never prompt, and the copy goes to the ssh user's own stage", () => {
    const [mkdir, scp] = peerCopyArgv(PEER, "/k/id")
    expect(mkdir).toEqual([
      "ssh",
      "-i",
      "/k/id",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      PEER.target,
      "mkdir",
      "-p",
      PEER_STAGE,
    ])
    expect(scp).toEqual([
      "scp",
      "-i",
      "/k/id",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      ...ROOT_NAMES.map((name) => join(SCRIPTS_DIR, name)),
      `${PEER.target}:${PEER_STAGE}/`,
    ])
  })

  test("the install runs PEER_INSTALL_TEXT through sudo reading stdin, with the card's hashes and no password", () => {
    const argv = peerInstallArgv(PEER, undefined, GOOD)
    expect(argv.slice(0, -1)).toEqual([
      "ssh",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      PEER.target,
    ])
    expect(argv.at(-1)).toBe(
      `sudo -k -S -p '' /bin/sh -c ${shQuote(PEER_INSTALL_TEXT)} sh "$HOME/${PEER_STAGE}" ${GOOD.map((s) => s.sha256).join(" ")}`,
    )
    expect(() =>
      peerInstallArgv(PEER, undefined, [
        { ...GOOD[0]!, sha256: `$(id)${"a".repeat(59)}` },
        ...GOOD.slice(1),
      ]),
    ).toThrow("hash is not 64 lowercase hex")
    expect(() => peerInstallArgv(PEER, undefined, GOOD.slice(1))).toThrow("An install lists")
  })

  test("a step reads its script, then runs it through pkexec with no argument; a name off the list is refused", () => {
    expect(peerReadArgv(PEER, undefined, "bwrap-userns").slice(6)).toEqual([
      "stat",
      "-c",
      "'%U %a %F %n'",
      ROOT_BASE,
      ROOT_DIR,
      `${ROOT_DIR}/bwrap-userns`,
      ";",
      "sha256sum",
      `${ROOT_DIR}/bwrap-userns`,
    ])
    expect(peerStepArgv(PEER, undefined, "bwrap-userns").slice(6)).toEqual([
      "/usr/bin/pkexec",
      "--disable-internal-agent",
      `${ROOT_DIR}/bwrap-userns`,
    ])
    expect(() => peerStepArgv(PEER, undefined, "../../bin/sh")).toThrow("is not a listed root step")
  })
})

describe("a peer's installed script check (PG-2434)", () => {
  const path = `${ROOT_DIR}/bwrap-userns`
  const sum = "a".repeat(64)
  const out = (script = "root 755 regular file", folder = "root 755 directory") =>
    [
      `root 755 directory ${ROOT_BASE}`,
      `${folder} ${ROOT_DIR}`,
      `${script} ${path}`,
      `${sum}  ${path}`,
    ].join("\n")

  test("passes root's own current copy", () => {
    expect(peerInstalledRefusal(out(), "bwrap-userns", sum)).toBeUndefined()
  })

  test("refuses a link, another owner, a script others can change, a missing one, and an older copy", () => {
    expect(peerInstalledRefusal(out("root 777 symbolic link"), "bwrap-userns", sum)).toContain(
      "is a link",
    )
    expect(peerInstalledRefusal(out("me 755 regular file"), "bwrap-userns", sum)).toContain(
      "not owned by root",
    )
    expect(peerInstalledRefusal(out("root 775 regular file"), "bwrap-userns", sum)).toContain(
      "changed by others",
    )
    expect(
      peerInstalledRefusal(out(undefined, "root 757 directory"), "bwrap-userns", sum),
    ).toContain(`${ROOT_DIR} can be changed by others`)
    expect(peerInstalledRefusal(out("root 755 directory"), "bwrap-userns", sum)).toContain(
      "is not a file",
    )
    expect(peerInstalledRefusal(`stat: cannot statx '${path}'`, "bwrap-userns", sum)).toContain(
      "is not there",
    )
    expect(peerInstalledRefusal(out(), "bwrap-userns", "b".repeat(64))).toBe(
      `${path} is an older copy: approve a new install card`,
    )
  })
})

describe("a peer's install text (PG-2434)", () => {
  let n = 0
  const setUp = async (user: string) => {
    const root = join(scratch, `install-${n++}`)
    const src = join(root, "src")
    const actions = join(root, "actions")
    const rules = join(root, "rules.d")
    for (const dir of [src, actions, rules]) mkdirSync(dir, { recursive: true })
    for (const name of ROOT_NAMES) await Bun.write(join(src, name), `#!/bin/sh\necho ${name}\n`)
    const text = `chown() { :; }\nSUDO_USER=${shQuote(user)}\n${PEER_INSTALL_TEXT.replace(
      `base=${ROOT_BASE}`,
      `base=${join(root, "base")}`,
    )
      .replaceAll(PEER_POLICY.slice(0, PEER_POLICY.lastIndexOf("/")), actions)
      .replaceAll(PEER_RULE.slice(0, PEER_RULE.lastIndexOf("/")), rules)}`
    expect(text.includes(`base=${ROOT_BASE}`) || text.includes("/etc/polkit-1")).toBe(false)
    // the password then a trap line on stdin, as ssh hands sudo's: the outer sh prints what the install left unread
    const run = (...hashes: string[]) =>
      runArgv(
        [
          "/bin/sh",
          "-c",
          'sh -c "$0" sh "$@"; c=$?; printf "\\nunread:%s" "$(cat)"; exit $c',
          text,
          src,
          ...hashes,
        ],
        10_000,
        `${MARKER}\nTRAP-LINE\n`,
      )
    return {
      base: join(root, "base"),
      policy: join(actions, PEER_POLICY.slice(PEER_POLICY.lastIndexOf("/") + 1)),
      root,
      rule: join(rules, PEER_RULE.slice(PEER_RULE.lastIndexOf("/") + 1)),
      run,
    }
  }
  const holding = (dir: string, value: string): string[] =>
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .filter((file) => readFileSync(file, "utf8").includes(value))

  test("installs the scripts, one polkit action per script pinned to its path, and a rule for that user alone", async () => {
    const { base, policy, root, rule, run } = await setUp("alice")
    const ran = await run(...GOOD.map((s) => s.sha256))
    expect(ran.code).toBe(0)
    expect(ran.out).toContain(`let alice run ${ROOT_NAMES.join(", ")} as root with no password`)
    for (const name of ROOT_NAMES) expect(existsSync(join(base, "root", name))).toBe(true)
    const actions = await Bun.file(policy).text()
    for (const name of ROOT_NAMES) {
      expect(actions).toContain(`<action id="${PEER_ACTION}.${name}">`)
      expect(actions).toContain(
        `<annotate key="org.freedesktop.policykit.exec.path">${ROOT_DIR}/${name}</annotate>`,
      )
    }
    expect(actions.match(/<action /g)).toHaveLength(ROOT_NAMES.length)
    expect(await Bun.file(rule).text()).toBe(
      [
        "// Playground root steps: these actions alone, for this user alone, with no password",
        "polkit.addRule(function (action, subject) {",
        `  if (subject.user === "alice" && [${ROOT_NAMES.map((name) => `"${PEER_ACTION}.${name}"`).join(", ")}].indexOf(action.id) >= 0) return polkit.Result.YES;`,
        "});",
        "",
      ].join("\n"),
    )
    for (const file of [policy, rule]) expect(statSync(file).mode & 0o777).toBe(0o644)
    expect(holding(root, "pw-MARKER")).toEqual([])
  })

  test("reads nothing from stdin, so the password line and all after it stay sudo's alone", async () => {
    const { run } = await setUp("alice")
    const ran = await run(...GOOD.map((s) => s.sha256))
    expect(ran.out.split("unread:")[1]).toBe(`${MARKER}\nTRAP-LINE`)
    expect(PEER_INSTALL_TEXT).not.toMatch(/\bread\b|cat -|<&0|\/dev\/stdin/)
  })

  test("refuses when sudo named no user, root, or a name a rule cannot hold, an uppercase or non-ASCII one included, writing no rule", async () => {
    for (const user of ["", "root", 'a" || true || "', "Bob", "\u00e9"]) {
      const { base, rule, run } = await setUp(user)
      const ran = await run(...GOOD.map((s) => s.sha256))
      expect(ran.code).toBe(1)
      expect(ran.err).toBe("refused: sudo named no user other than root, so the rule names no one")
      expect(existsSync(rule)).toBe(false)
      expect(existsSync(base)).toBe(false)
    }
  })

  test("refuses a script changed since approval, writing no rule", async () => {
    const { rule, run } = await setUp("alice")
    const ran = await run(...GOOD.slice(1).map((s) => s.sha256), "b".repeat(64))
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("changed since you approved it")
    expect(existsSync(rule)).toBe(false)
  })
})

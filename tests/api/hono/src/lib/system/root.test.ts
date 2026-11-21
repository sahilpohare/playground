import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runArgv } from "../../../../../../api/hono/src/lib/dashboard/run-argv"
import {
  caPin,
  installArgv,
  installedRefusal,
  PKEXEC,
  repoScripts,
  ROOT_TIMEOUT_MS,
  SCRIPTS_DIR,
  stepArgv,
} from "../../../../../../api/hono/src/lib/system/root"
import {
  CA_MAX_BYTES,
  INSTALL_TEXT,
  ROOT_BASE,
  ROOT_CA,
  ROOT_DIR,
  ROOT_NAMES,
} from "../../../../../../packages/config/src/inbox"

const scratch = mkdtempSync(join(tmpdir(), "root-step-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

const me = process.getuid!()
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex")

describe("a root step's argv (PG-2433)", () => {
  test("is pkexec on the one installed script, with no argument", () => {
    expect(stepArgv("bwrap-userns")).toEqual([
      "/usr/bin/pkexec",
      "--disable-internal-agent",
      `${ROOT_DIR}/bwrap-userns`,
    ])
  })

  test("refuses a script not on the list", () => {
    expect(() => stepArgv("apt-install")).toThrow("apt-install is not a listed root step")
    expect(() => stepArgv("../../bin/sh")).toThrow("is not a listed root step")
    expect(() => stepArgv("toString")).toThrow("is not a listed root step")
  })

  test("refuses any argument taken from a card", () => {
    expect(() => stepArgv("bwrap-userns", "--rm")).toThrow("A root step takes no argument")
  })

  test("waits on the password window for 5 minutes", () => {
    expect(ROOT_TIMEOUT_MS).toBe(300_000)
  })
})

describe("the install's argv (PG-2433)", () => {
  test("holds the install text constant byte for byte, the scripts folder, then each hash in order", async () => {
    const scripts = await repoScripts()
    const argv = installArgv(scripts)
    expect(argv.slice(0, 4)).toEqual([...PKEXEC, "/bin/sh", "-c"])
    expect(argv[4]).toBe(INSTALL_TEXT)
    expect(argv.slice(5)).toEqual(["sh", SCRIPTS_DIR, ...scripts.map((s) => s.sha256)])
  })

  test("refuses a hash that holds a quote or $(", async () => {
    const scripts = await repoScripts()
    for (const bad of [`${"a".repeat(63)}'`, `$(id)${"a".repeat(59)}`, "A".repeat(64), ""]) {
      const last = { ...scripts.at(-1)!, sha256: bad }
      expect(() => installArgv([...scripts.slice(0, -1), last])).toThrow(
        "hash is not 64 lowercase hex",
      )
    }
  })

  test("refuses a list that is not every listed script once, in order", () => {
    expect(() => installArgv([])).toThrow(`An install lists ${ROOT_NAMES.join(", ")}`)
    const twice = ROOT_NAMES.map((name) => ({ name, sha256: "a".repeat(64) }))
    expect(() => installArgv([...twice, ...twice])).toThrow("An install lists")
  })

  test("each listed script is in this checkout", async () => {
    expect((await repoScripts()).map((s) => s.name)).toEqual([...ROOT_NAMES])
  })
})

// The install text itself, run by sh as this user on scratch folders: its fixed folder swapped for a scratch one and chown for a no-op, so nothing reaches /usr.
describe("the install text (PG-2433)", () => {
  let n = 0
  const setUp = async () => {
    const root = join(scratch, `install-${n++}`)
    const src = join(root, "src")
    mkdirSync(src, { recursive: true })
    for (const name of ROOT_NAMES) await Bun.write(join(src, name), `#!/bin/sh\necho ${name}\n`)
    const text = `chown() { :; }\n${INSTALL_TEXT.replace(`base=${ROOT_BASE}`, `base=${join(root, "base")}`)}`
    expect(text).not.toContain(ROOT_BASE)
    const run = (...hashes: string[]) =>
      runArgv(["/bin/sh", "-c", text, "sh", src, ...hashes], 10_000)
    const good = ROOT_NAMES.map((name) => hash(`#!/bin/sh\necho ${name}\n`))
    return { base: join(root, "base"), good, run, src }
  }
  const leftover = (base: string) =>
    existsSync(base) ? readdirSync(base).filter((f) => f.startsWith(".stage")) : []

  test("installs each script whose copy matches the approved hash, then removes its staging folder", async () => {
    const { base, good, run } = await setUp()
    const ran = await run(...good)
    expect(ran).toMatchObject({
      code: 0,
      out: `installed ${ROOT_NAMES.join(", ")} in ${base}/root`,
    })
    for (const name of ROOT_NAMES) expect(existsSync(join(base, "root", name))).toBe(true)
    expect(leftover(base)).toEqual([])
  })

  test("refuses a source changed after approval, moving nothing", async () => {
    const { base, good, run, src } = await setUp()
    await Bun.write(join(src, ROOT_NAMES[0]), "#!/bin/sh\necho changed\n")
    const ran = await run(...good)
    expect(ran.code).toBe(1)
    expect(ran.err).toBe(`refused: ${ROOT_NAMES[0]} changed since you approved it`)
    expect(existsSync(join(base, "root", ROOT_NAMES[0]))).toBe(false)
    expect(leftover(base)).toEqual([])
  })

  test("refuses a hash that holds a quote, $( or an uppercase letter, and a wrong count of hashes, before it copies anything", async () => {
    const { base, good, run } = await setUp()
    for (const bad of [
      `${"a".repeat(63)}'`,
      `$(touch ${base}-pwned)`,
      "A".repeat(64),
      `${"a".repeat(63)}B`,
    ]) {
      const ran = await run(...good.slice(1), bad)
      expect(ran).toMatchObject({ code: 1, err: "refused: a hash is not 64 lowercase hex" })
    }
    expect((await run()).err).toContain("hashes are needed")
    expect(existsSync(`${base}-pwned`)).toBe(false)
    expect(existsSync(base)).toBe(false)
  })
})

describe("an installed script's check (PG-2433)", () => {
  let n = 0
  const installed = async (body?: string) => {
    const dir = join(scratch, `lib-${n++}`, "root")
    mkdirSync(dir, { recursive: true })
    chmodSync(join(dir, ".."), 0o755)
    chmodSync(dir, 0o755)
    const repo = join(scratch, `repo-${n}`)
    mkdirSync(repo, { recursive: true })
    await Bun.write(join(repo, "bwrap-userns"), "#!/bin/sh\necho ok\n")
    await Bun.write(join(dir, "bwrap-userns"), body ?? "#!/bin/sh\necho ok\n")
    chmodSync(join(dir, "bwrap-userns"), 0o755)
    return { dir, repo }
  }

  test("passes a copy owned by root, changed by root alone, matching this checkout's", async () => {
    const { dir, repo } = await installed()
    expect(await installedRefusal("bwrap-userns", { dir, owner: me, repo })).toBeUndefined()
  })

  test("refuses a path not owned by root", async () => {
    const { dir, repo } = await installed()
    expect(await installedRefusal("bwrap-userns", { dir, repo })).toBe(
      `${join(dir, "..")} is not owned by root: approve a new install card`,
    )
  })

  test("refuses a script others can change, a link, and one not there", async () => {
    const writable = await installed()
    chmodSync(join(writable.dir, "bwrap-userns"), 0o775)
    expect(await installedRefusal("bwrap-userns", { ...writable, owner: me })).toContain(
      "can be changed by others than root",
    )
    const linked = await installed()
    rmSync(join(linked.dir, "bwrap-userns"))
    symlinkSync(join(linked.repo, "bwrap-userns"), join(linked.dir, "bwrap-userns"))
    expect(await installedRefusal("bwrap-userns", { ...linked, owner: me })).toContain("is a link")
    const gone = await installed()
    rmSync(join(gone.dir, "bwrap-userns"))
    expect(await installedRefusal("bwrap-userns", { ...gone, owner: me })).toContain("is not there")
  })

  test("refuses a stale install rather than run old code", async () => {
    const { dir, repo } = await installed("#!/bin/sh\necho old\n")
    expect(await installedRefusal("bwrap-userns", { dir, owner: me, repo })).toBe(
      `${join(dir, "bwrap-userns")} is an older copy: approve a new install card`,
    )
  })
})

describe("runArgv's timeout (PG-2433)", () => {
  test("stops a run past its timeout", async () => {
    const started = Date.now()
    const ran = await runArgv(["sleep", "5"], 200)
    expect(ran.code).toBe(143)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

// A throwaway CA made by openssl in a scratch folder, its DER the bytes a pin hashes.
let cas = 0
const makeCa = (dir: string) => {
  const id = cas++
  const path = join(dir, `ca-${id}.pem`)
  const made = Bun.spawnSync([
    "openssl",
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    join(dir, `ca-${id}.key`),
    "-out",
    path,
    "-subj",
    "/CN=root step test CA",
    "-days",
    "1",
  ])
  expect(made.exitCode).toBe(0)
  const der = Bun.spawnSync(["openssl", "x509", "-in", path, "-outform", "DER"]).stdout
  return {
    der: Buffer.from(der),
    path,
    pin: new Bun.CryptoHasher("sha256").update(der).digest("hex"),
  }
}

describe("the Dashboard's CA in an install (PG-2458)", () => {
  let n = 0
  const setUp = async () => {
    const root = join(scratch, `ca-install-${n++}`)
    const src = join(root, "src")
    mkdirSync(src, { recursive: true })
    for (const name of ROOT_NAMES) await Bun.write(join(src, name), `#!/bin/sh\necho ${name}\n`)
    const text = `chown() { :; }\n${INSTALL_TEXT.replace(`base=${ROOT_BASE}`, `base=${join(root, "base")}`)}`
    const good = ROOT_NAMES.map((name) => hash(`#!/bin/sh\necho ${name}\n`))
    const run = (...args: string[]) =>
      runArgv(["/bin/sh", "-c", text, "sh", src, ...good, ...args], 10_000)
    return { base: join(root, "base"), ca: makeCa(root), root, run }
  }
  const nothingMoved = (base: string) => {
    expect(existsSync(join(base, "data", "portless-ca.der"))).toBe(false)
    expect(existsSync(join(base, "root", ROOT_NAMES[0]))).toBe(false)
    expect(readdirSync(base).filter((f) => f.startsWith(".stage"))).toEqual([])
  }

  test("pins a CA by its DER's sha256, the fingerprint a browser shows", async () => {
    const { ca } = await setUp()
    expect(await caPin(ca.path)).toBe(ca.pin)
    expect(ROOT_CA).toBe(`${ROOT_BASE}/data/portless-ca.der`)
  })

  test("keeps the CA's DER as root's own when it matches the approved hash", async () => {
    const { base, ca, run } = await setUp()
    const ran = await run(ca.path, ca.pin)
    expect(ran.code).toBe(0)
    expect(ran.out).toContain(`kept the Dashboard's CA in ${base}/data/portless-ca.der`)
    const kept = join(base, "data", "portless-ca.der")
    expect(readFileSync(kept).equals(ca.der)).toBe(true)
    expect(statSync(kept).mode & 0o777).toBe(0o644)
  })

  test("refuses a CA changed after approval, moving nothing", async () => {
    const { base, ca, root, run } = await setUp()
    const other = makeCa(root)
    await Bun.write(ca.path, Bun.file(other.path))
    const ran = await run(ca.path, ca.pin)
    expect(ran).toMatchObject({
      code: 1,
      err: "refused: the Dashboard's CA changed since you approved it",
    })
    nothingMoved(base)
  })

  test("refuses a file holding two certificates, and one over 16 KB, before openssl reads it", async () => {
    const { base, ca, root, run } = await setUp()
    const two = join(root, "two.pem")
    await Bun.write(
      two,
      `${await Bun.file(ca.path).text()}${await Bun.file(makeCa(root).path).text()}`,
    )
    expect(await run(two, ca.pin)).toMatchObject({
      code: 1,
      err: "refused: the CA file holds other than one certificate",
    })
    const big = join(root, "big.pem")
    await Bun.write(big, `${await Bun.file(ca.path).text()}${"#".repeat(CA_MAX_BYTES)}`)
    expect(await run(big, ca.pin)).toMatchObject({
      code: 1,
      err: "refused: the CA file is over 16 KB",
    })
    nothingMoved(base)
    expect(await caPin(two)).toBeUndefined()
    expect(await caPin(big)).toBeUndefined()
    expect(await caPin(join(root, "none.pem"))).toBeUndefined()
  })

  test("refuses a relative CA path and a hash that holds a quote, $( or an uppercase letter", async () => {
    const { base, ca, run } = await setUp()
    expect((await run("ca.pem", ca.pin)).err).toBe("refused: the CA's path is not absolute")
    for (const bad of [`${"a".repeat(63)}'`, `$(touch ${base}-pwned)`, "C".repeat(64)]) {
      expect((await run(ca.path, bad)).err).toBe("refused: a hash is not 64 lowercase hex")
    }
    expect(existsSync(`${base}-pwned`)).toBe(false)
    expect((await run(ca.path)).err).toContain("hashes are needed")
  })

  test("the argv carries the CA's path and hash last, and refuses either malformed", async () => {
    const scripts = await repoScripts()
    const argv = installArgv(scripts, undefined, {
      path: "/home/someone/ca.pem",
      sha256: "b".repeat(64),
    })
    expect(argv.slice(-2)).toEqual(["/home/someone/ca.pem", "b".repeat(64)])
    expect(argv[4]).toBe(INSTALL_TEXT)
    expect(() =>
      installArgv(scripts, undefined, { path: "ca.pem", sha256: "b".repeat(64) }),
    ).toThrow("The CA's path is not absolute")
    expect(() =>
      installArgv(scripts, undefined, { path: "/ca.pem", sha256: `$(id)${"b".repeat(59)}` }),
    ).toThrow("The CA's hash is not 64 lowercase hex")
  })
})

// The chromium-ca script itself, run by sh as this user: its fixed paths swapped for scratch ones and chown for a no-op, so nothing reaches /etc or /usr.
describe("the chromium-ca step (PG-2458)", () => {
  const source = readFileSync(join(SCRIPTS_DIR, "chromium-ca"), "utf8")
  const FOLDERS = ["/etc/chromium/policies/managed", "/etc/opt/chrome_for_testing/policies/managed"]
  let n = 0
  const setUp = () => {
    const root = join(scratch, `chromium-${n++}`)
    mkdirSync(root, { recursive: true })
    const der = join(root, "portless-ca.der")
    const dirs = FOLDERS.map((folder) => join(root, folder))
    let text = source.replace(ROOT_CA, der)
    for (const [i, folder] of FOLDERS.entries()) text = text.replace(folder, dirs[i]!)
    expect(text).not.toMatch(/[" ]\/etc\//)
    const run = () => runArgv(["/bin/sh", "-c", `chown() { :; }\n${text}`], 10_000)
    return { ca: makeCa(root), der, dirs, run }
  }

  test("reads the CA the install kept", () => {
    expect(source).toContain(`der=${ROOT_CA}\n`)
    for (const folder of FOLDERS) expect(source).toContain(folder)
  })

  test("writes each policy, mode 644, trusting the kept CA for localhost names alone", async () => {
    const { ca, der, dirs, run } = setUp()
    await Bun.write(der, ca.der)
    const ran = await run()
    expect(ran.code).toBe(0)
    for (const dir of dirs) {
      const file = join(dir, "portless-ca.json")
      expect(statSync(file).mode & 0o777).toBe(0o644)
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
        CACertificatesWithConstraints: [
          {
            certificate: ca.der.toString("base64"),
            constraints: { permitted_dns_names: ["localhost"] },
          },
        ],
      })
      expect(readdirSync(dir)).toEqual(["portless-ca.json"])
    }
    // run again, it rewrites its own file rather than refuse it
    expect((await run()).code).toBe(0)
  })

  test("refuses with no CA kept, writing nothing", async () => {
    const { dirs, run } = setUp()
    const ran = await run()
    expect(ran.code).toBe(1)
    expect(ran.err).toContain("no Dashboard CA is installed: approve a new install card")
    for (const dir of dirs) expect(existsSync(dir)).toBe(false)
  })

  test("refuses when another file in a policy folder already sets the key, naming it", async () => {
    const { ca, der, dirs, run } = setUp()
    await Bun.write(der, ca.der)
    const other = join(dirs[1]!, "corp.json")
    await Bun.write(other, '{"CACertificatesWithConstraints":[]}')
    const ran = await run()
    expect(ran).toMatchObject({
      code: 1,
      err: `refused: ${other} already sets CACertificatesWithConstraints, and two files setting it conflict`,
    })
    expect(existsSync(join(dirs[0]!, "portless-ca.json"))).toBe(false)
  })
})

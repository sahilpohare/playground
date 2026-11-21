import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { X509Certificate } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  CA_NAME,
  CA_POLICY,
  type CaProbe,
  chromiumSteps,
  firefoxProfiles,
  readCaTrust,
} from "../../../../../../api/hono/src/lib/dev/ca-trust"
import { CA as CA_PEM, OTHER, RESIGNED } from "./fixtures/ca"

// The made-up CA as portless keeps it, a file in its state folder.
const state = mkdtempSync(join(tmpdir(), "ca-trust-state-"))
const CA = join(state, "ca.pem")
writeFileSync(CA, CA_PEM)
afterAll(() => rmSync(state, { force: true, recursive: true }))

const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { force: true, recursive: true })
})

// A scratch HOME holding each named profile folder, with a cert9.db in those that have a store yet.
const home = (profiles: Record<string, boolean>) => {
  const dir = mkdtempSync(join(tmpdir(), "ca-trust-"))
  homes.push(dir)
  for (const [path, store] of Object.entries(profiles)) {
    mkdirSync(join(dir, path), { recursive: true })
    if (store) writeFileSync(join(dir, path, "cert9.db"), "")
  }
  return dir
}

const SNAP = "snap/firefox/common/.mozilla/firefox/abc.default"
const DEB = ".mozilla/firefox/xyz.default-release"

// certutil as a script: each profile's listing and the PEM it prints for CA_NAME; a profile it does not know fails.
const probe = (
  on: string[],
  stores: Record<string, { pem: string; trust: string }>,
): CaProbe & { ran: string[][] } => {
  const ran: string[][] = []
  return {
    has: (cmd) => on.includes(cmd),
    ran,
    run: async (argv) => {
      ran.push(argv)
      const store = stores[argv[3]!.replace(/^sql:/, "")]
      if (!store) return { code: 255, stdout: "" }
      return argv.includes("-a")
        ? { code: 0, stdout: store.pem }
        : {
            code: 0,
            stdout: `\nCertificate Nickname                                         Trust Attributes\n                                                             SSL,S/MIME,JAR/XPI\n\n${CA_NAME.padEnd(61)}${store.trust}\n`,
          }
    },
  }
}

describe("firefoxProfiles", () => {
  test("finds snap's and a deb Firefox's profiles that hold a store, and none in an empty home", () => {
    const dir = home({
      [DEB]: true,
      [SNAP]: true,
      "snap/firefox/common/.mozilla/firefox/new": false,
    })
    expect(firefoxProfiles(dir)).toEqual([join(dir, SNAP), join(dir, DEB)])
    expect(firefoxProfiles(home({}))).toEqual([])
  })

  test("finds Firefox 147's XDG root and flatpak's two roots too", () => {
    const XDG = ".config/mozilla/firefox/new.default-release"
    const FLATPAK = ".var/app/org.mozilla.firefox/.mozilla/firefox/old.default"
    const FLATPAK_XDG = ".var/app/org.mozilla.firefox/config/mozilla/firefox/new.default"
    const dir = home({ [FLATPAK]: true, [FLATPAK_XDG]: true, [XDG]: true })
    expect(firefoxProfiles(dir)).toEqual([
      join(dir, XDG),
      join(dir, FLATPAK),
      join(dir, FLATPAK_XDG),
    ])
  })
})

describe("readCaTrust", () => {
  test("a profile holding the CA's key, trusted for servers, trusts it, the proxy's re-signed copy included", async () => {
    const dir = home({ [DEB]: true, [SNAP]: true })
    const read = await readCaTrust(
      CA,
      dir,
      probe(["certutil"], {
        [join(dir, DEB)]: { pem: RESIGNED, trust: "C,," },
        [join(dir, SNAP)]: { pem: CA_PEM, trust: "CT,C,C" },
      }),
    )
    expect(read).toEqual({
      certutil: true,
      chromium: [],
      firefox: [join(dir, SNAP), join(dir, DEB)],
      policy: [],
      untrusted: [],
    })
  })

  test("another key, no server trust, or no entry at all leaves a profile untrusted", async () => {
    const dir = home({})
    const profiles = ["one", "two", "three"].map((name) => {
      const path = join(".mozilla/firefox", name)
      mkdirSync(join(dir, path), { recursive: true })
      writeFileSync(join(dir, path, "cert9.db"), "")
      return join(dir, path)
    })
    const read = await readCaTrust(
      CA,
      dir,
      probe(["certutil"], {
        [profiles[0]!]: { pem: OTHER, trust: "C,," },
        [profiles[1]!]: { pem: CA_PEM, trust: ",," },
      }),
    )
    expect(read.untrusted).toEqual(profiles.toSorted())
  })

  test("with no certutil every profile counts as untrusted and none is read", async () => {
    const dir = home({ [SNAP]: true })
    const run = probe([], {})
    const read = await readCaTrust(CA, dir, run)
    expect(read).toMatchObject({ certutil: false, untrusted: [join(dir, SNAP)] })
    expect(run.ran).toEqual([])
  })

  test("names each Chromium-family browser on PATH, which no file shows the trust of", async () => {
    const read = await readCaTrust(
      CA,
      home({}),
      probe(["helium", "google-chrome", "firefox"], {}),
      null,
    )
    expect(read.chromium).toEqual(["google-chrome", "helium"])
    expect(read.firefox).toEqual([])
  })

  // the policy chromium-ca writes, its certificate the DER as base64 (PG-2458)
  const policy = (pem: string) => {
    const path = join(home({}), "portless-ca.json")
    writeFileSync(
      path,
      JSON.stringify({
        CACertificatesWithConstraints: [
          {
            certificate: new X509Certificate(pem).raw.toString("base64"),
            constraints: { permitted_dns_names: ["localhost"] },
          },
        ],
      }),
    )
    return path
  }

  test("a policy holding the CA's key covers Helium alone, since Ubuntu's chromium snap reads another folder (PG-2458)", async () => {
    const on = probe(["helium", "chromium", "chromium-browser", "google-chrome"], {})
    expect(await readCaTrust(CA, home({}), on, policy(RESIGNED))).toMatchObject({
      chromium: ["chromium", "chromium-browser", "google-chrome"],
      policy: ["helium"],
    })
    expect(await readCaTrust(CA, home({}), on, policy(OTHER))).toMatchObject({
      chromium: ["chromium", "chromium-browser", "google-chrome", "helium"],
      policy: [],
    })
    expect(await readCaTrust(CA, home({}), on, join(state, "none.json"))).toMatchObject({
      policy: [],
    })
  })

  test("the policy path is the folder chromium-ca writes", async () => {
    const script = await Bun.file(
      join(import.meta.dir, "../../../../../../api/hono/src/lib/system/root/chromium-ca"),
    ).text()
    expect(script).toContain(CA_POLICY.replace("/portless-ca.json", ""))
  })
})

describe("chromiumSteps", () => {
  test("names the browser's own import with the CA's path, the restart, and Turn on warnings", () => {
    const steps = chromiumSteps(["helium"], "/home/x/.portless/fallback/ca.pem")
    expect(steps).toContain("In helium, open chrome://certificate-manager")
    expect(steps).toContain("Import /home/x/.portless/fallback/ca.pem")
    expect(steps).toContain("Restart the browser")
    expect(steps).toContain("Turn on warnings")
    expect(steps).toContain("through the chromium-ca root step, which you approve in the Inbox")
    expect(chromiumSteps(["google-chrome"], "/ca.pem")).not.toContain("chromium-ca")
  })
})

import { X509Certificate } from "node:crypto"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Which of Linux's browsers trust portless's CA, which no setup step puts in a browser's own store. Firefox keeps an NSS store in each profile, read here and written by the ca-trust fix with certutil. A Chromium-family browser trusts the CA through its own certificate manager, which no file here reads, or through the managed policy the chromium-ca root step writes, read here: ~/.pki/nssdb holding it as C,, was measured not to count on Chromium 157 and 159. Imports only node: modules, since playground doctor reads it too.

export const CA_NAME = "portless Local CA"

// The Chromium-family browsers whose own import the steps name, by the command each puts on PATH.
export const CHROMIUM = [
  "brave-browser",
  "chromium",
  "chromium-browser",
  "google-chrome",
  "google-chrome-stable",
  "helium",
  "microsoft-edge",
  "vivaldi",
]

// The managed policy the chromium-ca root step writes (api/hono/src/lib/system/root/chromium-ca) in the folder Helium reads, world-readable, and the browser on PATH that reads it; Ubuntu's chromium is the snap, which reads /etc/chromium-browser/policies instead.
export const CA_POLICY = "/etc/chromium/policies/managed/portless-ca.json"
const READS_CA_POLICY = ["helium"]

// In a Chromium-family browser's own words: its certificate manager's import, and the page info button that drops a Proceed made before it (IDS_PAGE_INFO_RESET_INVALID_CERTIFICATE_DECISIONS_BUTTON, "Turn on warnings").
export const chromiumSteps = (browsers: string[], ca: string): string =>
  `In ${browsers.join(", ")}, open chrome://certificate-manager, then Local certificates, Custom, Installed by you, Trusted certificates, and Import ${ca}. Restart the browser. If the address still reads Not secure, click it and choose Turn on warnings, which drops a Proceed you clicked before.${browsers.some((cmd) => READS_CA_POLICY.includes(cmd)) ? " Helium can trust it instead through the chromium-ca root step, which you approve in the Inbox." : ""}`

export type CaProbe = {
  has: (cmd: string) => boolean
  run: (argv: string[]) => Promise<{ code: number; stdout: string }>
}

export type CaTrust = {
  certutil: boolean
  chromium: string[]
  firefox: string[]
  policy: string[]
  untrusted: string[]
}

// Each Firefox profile that has its certificate store yet: snap's under ~/snap/firefox/common, a deb or tarball Firefox's under ~/.mozilla, Firefox 147's and later's under ~/.config, and flatpak's under ~/.var/app in either layout.
export const firefoxProfiles = (home: string): string[] =>
  [
    join(home, "snap", "firefox", "common", ".mozilla", "firefox"),
    join(home, ".mozilla", "firefox"),
    join(home, ".config", "mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", ".mozilla", "firefox"),
    join(home, ".var", "app", "org.mozilla.firefox", "config", "mozilla", "firefox"),
  ].flatMap((root) => {
    try {
      return readdirSync(root)
        .map((name) => join(root, name))
        .filter((profile) => existsSync(join(profile, "cert9.db")))
        .toSorted()
    } catch {
      return []
    }
  })

// A certificate's public key, so a copy the proxy signed again still matches its CA; null for text that holds none.
const keyOf = (cert: string | Buffer): string | null => {
  try {
    return new X509Certificate(cert).publicKey
      .export({ format: "der", type: "spki" })
      .toString("hex")
  } catch {
    return null
  }
}

const PEM_END = "-----END CERTIFICATE-----"

// Whether a profile's store holds the CA's key under CA_NAME, trusted to issue server certificates (C in its SSL field).
const trustedIn = async (profile: string, key: string, probe: CaProbe): Promise<boolean> => {
  const db = `sql:${profile}`
  const listed = await probe.run(["certutil", "-L", "-d", db])
  const trust = listed.stdout
    .split("\n")
    .find((line) => line.startsWith(`${CA_NAME} `))
    ?.trim()
    .split(/\s+/)
    .at(-1)
  if (listed.code !== 0 || !trust?.split(",")[0]?.includes("C")) return false
  const pems = await probe.run(["certutil", "-L", "-d", db, "-n", CA_NAME, "-a"])
  return (
    pems.code === 0 &&
    pems.stdout
      .split(PEM_END)
      .slice(0, -1)
      .some((pem) => keyOf(`${pem}${PEM_END}`) === key)
  )
}

// Whether the managed policy at path names the CA's key among the certificates it trusts.
const policyHolds = (path: string, key: string): boolean => {
  try {
    const policy = JSON.parse(readFileSync(path, "utf8")) as {
      CACertificatesWithConstraints?: { certificate?: string }[]
    }
    return (policy.CACertificatesWithConstraints ?? []).some(
      (entry) =>
        typeof entry.certificate === "string" &&
        keyOf(Buffer.from(entry.certificate, "base64")) === key,
    )
  } catch {
    return false
  }
}

// What trusts the CA file at ca: each Firefox profile, those that do not (every one while certutil is missing, since none can be read), the Chromium-family browsers on PATH that the managed policy at policyPath covers (none with no path), and the rest, which only the owner's import reaches.
export const readCaTrust = async (
  ca: string,
  home: string,
  probe: CaProbe,
  policyPath: string | null = CA_POLICY,
): Promise<CaTrust> => {
  const firefox = firefoxProfiles(home)
  const certutil = probe.has("certutil")
  const key = (() => {
    try {
      return keyOf(readFileSync(ca, "utf8"))
    } catch {
      return null
    }
  })()
  const untrusted: string[] = []
  for (const profile of firefox)
    if (!certutil || !key || !(await trustedIn(profile, key, probe))) untrusted.push(profile)
  const covered = key !== null && policyPath !== null && policyHolds(policyPath, key)
  const onPath = CHROMIUM.filter((cmd) => probe.has(cmd))
  const byPolicy = (cmd: string) => covered && READS_CA_POLICY.includes(cmd)
  return {
    certutil,
    chromium: onPath.filter((cmd) => !byPolicy(cmd)),
    firefox,
    policy: onPath.filter(byPolicy),
    untrusted,
  }
}

// Pure: where the CA is trusted, as an ok row reads it.
export const trustedWhere = (read: CaTrust): string =>
  [
    read.firefox.length > 0 && "trusted in Firefox",
    read.policy.length > 0 && `trusted in ${read.policy.join(", ")} through the browser policy`,
  ]
    .filter(Boolean)
    .join("; ") || "no browser found"

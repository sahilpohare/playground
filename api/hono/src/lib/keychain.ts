import { userInfo } from "node:os"

import { keychainSpec } from "./keychain-items"

// One allowlisted generic password in the macOS Keychain (keychainSpec in keychain-items.ts), as the signed-in user, through `security`.

// input goes to the command's stdin, so a secret travels there and never in an argv another process can read
export type Run = (
  argv: string[],
  input?: string,
) => Promise<{ code: number; stderr: string; stdout: string }>

const spawnRun: Run = async (argv, input) => {
  const child = Bun.spawn(argv, {
    stderr: "pipe",
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stderr, stdout }
}

export function keychainItem(
  name: string,
  { account = userInfo().username, run = spawnRun }: { account?: string; run?: Run } = {},
) {
  const spec = keychainSpec(name)
  if (!spec) throw new Error(`${name} is not a Keychain item Playground may use`)
  const { invalid, service, valid } = spec
  const item = ["-s", service, "-a", account]
  return {
    read: async (): Promise<string | null> => {
      const found = await run(["security", "find-generic-password", ...item, "-w"])
      const value = found.stdout.trim()
      return found.code === 0 && valid.test(value) ? value : null
    },
    remove: async (): Promise<void> => {
      await run(["security", "delete-generic-password", ...item])
    },
    // through `security -i` on stdin, so no argv holds the value; each word sits in double quotes, so none may hold a quote, a backslash or a line break
    write: async (value: string): Promise<void> => {
      if (!valid.test(value) || /["\\\n\r]/.test(value)) throw new Error(invalid)
      if (!/^[A-Za-z0-9._+@-]+$/.test(account)) throw new Error(`${account} is not an account name`)
      const wrote = await run(
        ["security", "-i"],
        `add-generic-password -U -s "${service}" -a "${account}" -w "${value}"\n`,
      )
      if (wrote.code !== 0 || wrote.stderr.trim()) {
        const said = (wrote.stderr.trim().split("\n")[0] ?? "").split(value).join("…")
        throw new Error(`the secret store refused it: ${said || `exit ${wrote.code}`}`)
      }
    },
  }
}

export type KeychainItem = ReturnType<typeof keychainItem>

import { test } from "bun:test"

// Why zsh is missing from the PATH a row's child gets (this process's unless the row names its own, since Bun finds a child's program on the PATH its own env holds), or undefined: the runner host has none, while GitHub CI's Suite shards install it.
export const zshMissing = (PATH?: string) =>
  Bun.which("zsh", { PATH: PATH ?? process.env.PATH ?? "" })
    ? undefined
    : `zsh not on ${PATH ? `PATH ${PATH}` : "PATH"}; GitHub CI (install-zsh) and a local run cover this row`

// Pure: a row runs when nothing it needs is missing, skips when something is, and fails under CI, which provides every need, so a lost install reads red there.
export const rowMode = (reason: string | undefined, ci: string | undefined) =>
  !reason ? "run" : ci ? "fail" : "skip"

// test(), unless the machine lacks what the row needs: then a skip whose name gives the reason, or under CI a failure naming it.
export const machineTest = (
  reason: string | undefined,
  name: string,
  fn: () => void | Promise<unknown>,
) => {
  const mode = rowMode(reason, process.env.CI)
  if (mode === "run") return test(name, fn)
  if (mode === "skip") return test.skip(`${name} (skipped: ${reason})`, fn)
  return test(name, () => {
    throw new Error(`${reason}, but CI runs it: this machine lacks what CI provides`)
  })
}

// A scratch git checkout at dir whose origin is the made-up GitHub repo given, for a hook's checkout argument, so a row that reads the checkout's origin never reads the running checkout's, which the runner host's run clone lacks.
export const originCheckout = (dir: string, repo: string): string => {
  Bun.spawnSync(["git", "init", "-q", dir])
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", `https://github.com/${repo}.git`])
  return dir
}

// A made-up `claude setup-token` for fixture stacks and tests, so no stack off this machine's own reads starts the real one: as the real one does, it hands $BROWSER a sign-in link of its own, prints the paste-the-code link wrapped at its terminal's width, reads one code as Ink does, then prints a made-up token for it; for the code "refused" it prints 2.1.314's own reject screen and waits, as the real one does, for "slow" it answers 5s late, for "silent" never, as a sign-in on a dropping link does, and for "drawn" it prints a token of the real one's 108 characters with a cursor move, not a line break, before the next word, as Ink draws it.
import { createHash, randomUUID } from "node:crypto"

if (process.argv[2] !== "setup-token") {
  console.error("this made-up claude takes setup-token alone")
  process.exit(2)
}

// Ink reads its pty raw: a chunk that holds a paste is text even when it ends in Enter, and only an Enter of its own submits; measured on setup-token 2.1.314, a 25-character code with its Enter submits and a 130-character one does not.
const PASTE = 64
if (process.stdin.isTTY) process.stdin.setRawMode(true)
const typed = () =>
  new Promise<string>((resolve) => {
    let text = ""
    process.stdin.on("data", (chunk: Buffer) => {
      const keys = chunk.toString()
      const enter = /[\r\n]$/.test(keys)
      text += keys.replace(/[\r\n]/g, "")
      if (enter && keys.length <= PASTE) resolve(text.trim())
    })
  })

const columns = process.stdout.columns || 80
const wrap = (text: string) => text.match(new RegExp(`.{1,${columns}}`, "g"))!.join("\n")
const state = randomUUID().replaceAll("-", "")
const link = (redirect: string) =>
  `https://claude.com/cai/oauth/authorize?code=true&client_id=made-up-client&response_type=code&redirect_uri=${encodeURIComponent(redirect)}&scope=user%3Ainference&state=${state}`
const url = link("https://example.com/oauth/code/callback")
if (process.env.BROWSER)
  Bun.spawnSync([process.env.BROWSER, link("http://localhost:54545/callback")])

process.stdout.write(
  `\x1b[1mWelcome to Claude Code\x1b[22m\n\nOpening browser to sign in…\n\nBrowser didn't open? Use the url below to sign in (c to copy)\n\n\x1b[2m${wrap(url)}\x1b[22m\n\nPaste code here if prompted > `,
)
const code = await typed()
process.stdin.pause()
// Each of these holds its pty open with no answer, as setup-token does after a refusal and on a link that has dropped.
const hold = () => new Promise(() => setInterval(() => {}, 60_000))
if (code === "refused") {
  process.stdout.write(
    "\nOAuth error: That code wasn't accepted. It may be incomplete, expired, already used, or from an earlier sign-in attempt. Sign in again to get a new code.\n\nPress Enter to retry.\n",
  )
  await hold()
}
if (code === "silent") await hold()
if (code === "slow") await Bun.sleep(5_000)
const hex = createHash("sha256").update(code).digest("hex")
const token =
  code === "drawn"
    ? `sk-ant-oat01-${hex}-made-up-${"A".repeat(22)}`
    : `sk-ant-oat01-${hex}-made-up-AA`
const after = code === "drawn" ? "\x1b[2B\x1b[1G" : "\n\n"
process.stdout.write(
  `\n\x1b[32m✓\x1b[39m Long-lived authentication token created successfully!\n\nYour OAuth token (valid for 1 year):\n\n${wrap(token)}${after}Store this token securely. You won't be able to see it again.\n`,
)

// A made-up fix for fixture stacks, so no stack off this machine's own reads installs anything: it prints a few lines over about 2s and exits 0; gh-login prints a one-time code as gh does and waits for Enter, codex-login a made-up link and code as Codex does, and claude-login a made-up sign-in link, each held up for about 3s before it signs in as no one.
import { FIX_IDS } from "../lib/onboard/fix-ids"

const id = process.argv[2] ?? ""
if (!(FIX_IDS as readonly string[]).includes(id)) {
  console.error(`this made-up fix takes one of ${FIX_IDS.join(", ")}`)
  process.exit(2)
}

const say = async (line: string) => {
  process.stdout.write(`${line}\n`)
  await Bun.sleep(400)
}

if (id === "gh-login") {
  await say("! First copy your one-time code: MADE-0001")
  process.stdout.write(`Press Enter to open https://github.com/login/device in your browser... `)
  for await (const _ of console) break
  await say("")
  await say("Waiting for the code to be entered at GitHub")
  await Bun.sleep(3_000)
  await say("✓ Authentication complete.")
  await say("✓ Logged in as made-up-owner")
} else if (id === "codex-login") {
  await say("Follow these steps to sign in with ChatGPT using device code authorization:")
  await say("1. Open this link in your browser and sign in to your account")
  await say("   https://auth.openai.com/codex/device")
  await say("2. Enter this one-time code (expires in 15 minutes)")
  await say("   MADE-00001")
  await Bun.sleep(3_000)
  await say("Successfully logged in")
} else if (id === "claude-login") {
  await say("Browser didn't open? Use the url below to sign in:")
  await say("https://claude.ai/oauth/authorize?made-up=1")
  await Bun.sleep(3_000)
  await say("Login successful.")
} else {
  await say(`Made-up ${id} fix: nothing is installed on a fixture stack`)
  await say("Working")
  await say("Done")
}

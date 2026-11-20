// The far end of ops-peer-relay: the relay starts it over ssh from the far machine's own checkout, so nothing is installed there. It says hello first, then streams its machine's ops-peer.jsonl from the byte offset its argument names ("end" for the queue's end), each line as {end, line}, and appends each {line} the relay sends unless its id is already there, answering {ack}. It imports node built-ins and its siblings alone, so a checkout with no install runs it, and it ends when ssh closes its stdin.
import { homedir } from "node:os"
import { join } from "node:path"

import { PEER_QUEUE } from "../playground/send"
import { appendOnce, HELLO, isPeerLine, linesFrom, parsed } from "./queue"

export async function agent(
  argv: string[],
  input: AsyncIterable<string>,
  say: (message: object) => void,
  path: string,
  pollMs = 500,
): Promise<void> {
  say(HELLO)
  // a test holds the far end here (argv[1] ms) between hello and reading its start, so a line landed after the link is up is read past it; inert with no second argument
  const delayMs = Number(argv[1])
  if (Number.isInteger(delayMs) && delayMs >= 0) await Bun.sleep(delayMs)
  const named = Number(argv[0])
  let at = Number.isInteger(named) && named >= 0 ? named : Bun.file(path).size
  say({ end: at })
  let open = true
  const reading = (async () => {
    for await (const text of input) {
      const message = parsed(text) as { line?: unknown } | undefined
      const line = message?.line
      if (isPeerLine(line)) await appendOnce(path, line)
      say({ ack: (line as { id?: unknown } | undefined)?.id ?? null })
    }
    open = false
  })()
  while (open) {
    const { end, reads, skipped } = await linesFrom(path, at)
    for (const read of reads) say(read)
    if (skipped || end !== at) say({ end, skipped })
    at = end
    await Promise.race([reading, Bun.sleep(pollMs)])
  }
}

// The lines of a byte stream, each without its newline.
export async function* linesOf(stream: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let held = ""
  for await (const chunk of stream) {
    held += decoder.decode(chunk, { stream: true })
    let at: number
    while ((at = held.indexOf("\n")) >= 0) {
      yield held.slice(0, at)
      held = held.slice(at + 1)
    }
  }
}

if (import.meta.main) {
  const data = process.env.PLAYGROUND_DATA_DIR || join(homedir(), ".playground")
  await agent(
    process.argv.slice(2),
    linesOf(Bun.stdin.stream()),
    (message) => process.stdout.write(`${JSON.stringify(message)}\n`),
    join(data, "ops", "outbox", PEER_QUEUE),
  )
  process.exit(0)
}

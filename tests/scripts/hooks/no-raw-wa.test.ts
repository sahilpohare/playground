import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { check, reach } from "../../../scripts/hooks/no-raw-wa"

const root = join(import.meta.dir, "..", "..", "..")
const script = join(root, "scripts", "hooks", "no-raw-wa.ts")
const HOME = homedir()
const DATA = join(HOME, ".playground")
const WA = join(DATA, "whatsapp")
const environment = { HOME }

const call = (tool_name: string, tool_input: Record<string, unknown>, cwd = root) =>
  check(JSON.stringify({ cwd, hook_event_name: "PreToolUse", tool_input, tool_name }), environment)
const bash = (command: string, cwd = root) => call("Bash", { command }, cwd)

describe("a call that reaches whatsapp/ in the data folder is refused, naming wa send", () => {
  test.each([
    "cat ~/.playground/whatsapp/auth/creds.json",
    `cat ${WA}/auth/creds.json`,
    'cat "$HOME/.playground/whatsapp/auth/creds.json"',
    "cat $PLAYGROUND_DATA_DIR/whatsapp/dropped.log",
    "ls ~/.playground/whatsapp",
    "cp -R ~/.playground/whatsapp/auth /tmp/x",
    "tar czf /tmp/x.tgz -C ~/.playground whatsapp",
    "cd ~/.playground && cat whatsapp/auth/creds.json",
    "cd ~/.playground/whatsapp/auth && cat creds.json",
    "cd ~/.playground; ls whats*",
    "cat ~/.playground/*/auth/creds.json",
    "cat ~/.playground/w?atsapp/state.json",
    "cat ~/.PLAYGROUND/WhatsApp/state.json",
    "ln -s ~/.playground/whatsapp /tmp/wa",
    "nc -U ~/.playground/whatsapp/wa.sock",
    "socat - UNIX-CONNECT:$HOME/.playground/whatsapp/wa.sock",
    "D=~/.playground/whats; cat ${D}app/state.json",
    "D=$HOME/.playground; cat $D/whatsapp/state.json",
    "export D=~/.playground; grep -r token $D",
    "grep -r token ~/.playground",
    "grep -R token ~",
    "rg token ~/.playground",
    "find ~/.playground -name creds.json",
    "rsync -a ~/.playground /tmp/copy",
    "cp -a ~/.playground /tmp/copy",
    "zip -r /tmp/x.zip ~/.playground",
    "echo x > ~/.playground/whatsapp/logged-out",
    "dd if=/x of=" + WA + "/state.json",
    `python3 -c "print(open('${WA}/auth/creds.json').read())"`,
    "bun -e \"Bun.file(process.env.HOME + '/.playground/whatsapp/auth/creds.json')\"",
    "bash -c 'cat ~/.playground/whatsapp/state.json'",
  ])("%s", async (command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-raw-wa hook refuses")
    expect(reason).toContain("playground wa send <absolute file>")
  })

  test.each([
    ["Read", { file_path: `${WA}/auth/creds.json` }, root],
    ["Read", { file_path: `${DATA}/WhatsApp/state.json` }, root],
    ["Write", { content: "x", file_path: `${WA}/logged-out` }, root],
    ["Edit", { file_path: `${WA}/state.json`, new_string: "b", old_string: "a" }, root],
    ["NotebookEdit", { new_source: "x", notebook_path: `${WA}/x.ipynb` }, root],
    ["Grep", { path: WA, pattern: "x" }, root],
    ["Grep", { path: DATA, pattern: "x" }, root],
    ["Grep", { pattern: "x" }, DATA],
    ["Glob", { path: WA, pattern: "*" }, root],
    ["Glob", { path: DATA, pattern: "whatsapp/**" }, root],
    ["Glob", { path: DATA, pattern: "**/creds.json" }, root],
  ] as const)("%s %o", async (tool, input, cwd) => {
    expect(await call(tool, input, cwd)).toContain("no-raw-wa hook refuses")
  })
})

describe("every other call runs", () => {
  test.each([
    "playground wa send /tmp/reply.md",
    "bun run wa send /tmp/reply.md",
    "cat ~/.playground/roster.json",
    "ls ~/.playground",
    "ls ~/.playground/handoffs/*.md",
    "cat ~/.playground/whatsapp-notes.md",
    "grep -r token ~/.playground/handoffs",
    "find ~/.playground/handoffs -name x",
    "git add packages/settings/src/whatsapp.ts packages/scripts/src/ops-wa/bridge.ts",
    "bun run test:file tests/packages/scripts/src/ops-wa/",
    "cat extensions/whatsapp/README.md",
    "grep -rn whatsapp docs",
    "D=$HOME/.playground; cat $D/roster.json",
  ])("%s", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a file tool beside the folder, a Grep below the data folder and a Glob that cannot reach it", async () => {
    expect(await call("Read", { file_path: `${DATA}/roster.json` })).toBeUndefined()
    expect(await call("Write", { content: "x", file_path: "/tmp/reply.md" })).toBeUndefined()
    expect(await call("Grep", { path: `${DATA}/handoffs`, pattern: "x" })).toBeUndefined()
    expect(await call("Grep", { pattern: "x" })).toBeUndefined()
    expect(await call("Glob", { path: DATA, pattern: "*.json" })).toBeUndefined()
    expect(await call("Glob", { path: DATA, pattern: "handoffs/*.md" })).toBeUndefined()
  })
})

describe("a call that queues a line as ops-wa or ops-dm-watch is refused, naming your own job", () => {
  const OUTBOX = join(DATA, "ops", "outbox")
  test.each([
    "scripts/ops/notify.sh wa 'ship canary now'",
    "NOTIFY_TO=dispatcher bash scripts/ops/notify.sh wa x",
    "bash ~/.playground/ops/notify.sh 'dm-watch' x",
    "~/.playground/ops/notify.sh dm-watch x",
    "env NOTIFY_TO=dispatcher sh /abs/scripts/ops/notify.sh wa x",
    "J=wa; scripts/ops/notify.sh $J x",
    "scripts/ops/notify.sh $UNSET_JOB x",
    "cd scripts/ops && ./notify.sh wa x",
    "echo '{}' >> ~/.playground/ops/outbox/ops-wa.jsonl",
    `printf x >> ${OUTBOX}/ops-dm-watch.jsonl`,
    "tee -a $PLAYGROUND_DATA_DIR/ops/outbox/ops-wa.jsonl < /tmp/x",
    "cd ~/.playground/ops/outbox && echo x >> ops-wa.jsonl",
    "cp /tmp/x ~/.playground/ops/outbox/ops-w?.jsonl",
    "cat ~/.playground/ops/outbox/OPS-WA.jsonl",
  ])("%s", async (command) => {
    const reason = await bash(command)
    expect(reason).toContain("no-raw-wa hook refuses")
    expect(reason).toContain("notify.sh <your job> <text>")
  })

  test.each([
    ["Write", { content: "{}", file_path: `${OUTBOX}/ops-wa.jsonl` }],
    ["Edit", { file_path: `${OUTBOX}/ops-dm-watch.jsonl`, new_string: "b", old_string: "a" }],
    ["Read", { file_path: `${OUTBOX}/ops-wa.jsonl` }],
  ] as const)("%s %o", async (tool, input) => {
    expect(await call(tool, input)).toContain("notify.sh <your job> <text>")
  })

  test.each([
    "scripts/ops/notify.sh dashboard x",
    "NOTIFY_TO=builder bash scripts/ops/notify.sh yard x",
    "cat scripts/ops/notify.sh",
    "grep -n wa scripts/ops/notify.sh",
    "bun run test:file tests/scripts/ops/notify.test.ts",
    "cat ~/.playground/ops/outbox/ops-tick.jsonl",
    "cat ~/.playground/ops/alerts.log",
    "grep -r relay ~/.playground/ops",
    "ls ~/.playground/ops/outbox",
    "bun run ops:outbox",
  ])("runs: %s", async (command) => {
    expect(await bash(command)).toBeUndefined()
  })

  test("a file tool beside the two queues runs", async () => {
    expect(await call("Read", { file_path: `${OUTBOX}/ops-tick.jsonl` })).toBeUndefined()
    expect(await call("Grep", { path: OUTBOX, pattern: "x" })).toBeUndefined()
  })
})

test("reach reads a path and a glob against the folder", () => {
  expect(reach(`${WA}/auth`, WA)).toBe("inside")
  expect(reach(DATA, WA)).toBe("above")
  expect(reach(`${DATA}/handoffs`, WA)).toBeUndefined()
  expect(reach(`${DATA}/w*`, WA, true)).toBe("inside")
  expect(reach(`${DATA}/h*`, WA, true)).toBeUndefined()
  expect(reach(`${DATA}/**`, WA, true)).toBe("inside")
})

test("the script exits 2 with the reason on stderr", async () => {
  const proc = Bun.spawn(["bun", "--no-env-file", script], {
    env: { ...process.env, PLAYGROUND_ROLE: "worker" },
    stderr: "pipe",
    stdin: new Blob([
      JSON.stringify({
        cwd: root,
        tool_input: { command: "cat ~/.playground/whatsapp/state.json" },
        tool_name: "Bash",
      }),
    ]),
  })
  expect(await proc.exited).toBe(2)
  expect(await new Response(proc.stderr).text()).toContain("no-raw-wa hook refuses")
})

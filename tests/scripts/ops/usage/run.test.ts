import { afterAll, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const script = join(import.meta.dir, "..", "..", "..", "..", "scripts", "ops", "usage", "run.py")
const repo = join(import.meta.dir, "..", "..", "..", "..")
const beat = join(repo, "scripts", "ops", "beat.py")
const scratch = mkdtempSync(join(tmpdir(), "ops-usage-run-"))
afterAll(() => rmSync(scratch, { force: true, recursive: true }))

// run.py's functions, loaded without its loop, with beat and the Keychain probe stubbed, under a scratch HOME as tests/test_ops_merge_train.py does; the rule's factory_login and has_token are the real ones beat.py carries
const harness = `
import json, os, sys, time, types
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
beat["subprocess"] = types.SimpleNamespace(run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="", stderr=""))
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
calls = []
ns["probe"] = lambda e: calls.append(e) or {"five": 10, "fiveReset": time.time() + 3600, "week": 40 if e == "spare@example.org" else 50, "weekReset": time.time() + 86400}
factory = ns["factory_reading"]({"account": "mine@example.org", "rate_limits": {}}, ns["flip_file"](), ["main@example.org", "spare@example.org"])
accounts = ns["accounts_reading"]()
print(json.dumps({"accounts": {k: v["week"] for k, v in accounts.items()}, "factory": factory and factory["account"], "keys": sorted(json.load(open(ns["FLIP"]))), "probes": calls, "rotation": ns["rotation"](ns["flip_file"]())}))
line = {}
try:
    folder = os.path.dirname(os.path.dirname(os.path.dirname(ns["FLIP"])))
    ns["write_stored"]({"account": "stored@example.org", "rate_limits": {"five_hour": {"used_percentage": 10, "resets_at": 123}, "seven_day": {"used_percentage": 97, "resets_at": 456}}, "source": "oauth/usage", "writtenAt": "2026-10-24T01:00:00Z"})
    ns["write_stored"]({"account": None})
    line = {"stored": json.load(open(os.path.join(folder, "usage-stored.json"))), "noNone": not os.path.exists(os.path.join(folder, "usage-None.json"))}
except Exception as e:
    line = {"error": str(e)}
print(json.dumps(line))
`

const runRaw = (name: string, flip: object) => {
  const home = join(scratch, name)
  const folder = join(home, ".playground", "ops", "usage")
  mkdirSync(folder, { recursive: true })
  writeFileSync(join(folder, "login-flip.json"), JSON.stringify(flip))
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(["python3", "-I", "-c", harness, script, beat], { env })
  expect(child.stderr.toString()).toBe("")
  return child.stdout.toString().trim().split("\n")
}

const run = (name: string, flip: object) => JSON.parse(runRaw(name, flip)[0]!)

const stale = { at: 0, week: 1 }

test("each account in `accounts` is probed once a cycle, the factory's shared with its own reading", () => {
  expect(
    run("two", {
      accounts: ["main@example.org", "spare@example.org"],
      due: "x",
      factory: "main@example.org",
      seen: { "spare@example.org": stale, "main@example.org": stale },
    }),
  ).toEqual({
    accounts: { "spare@example.org": 40, "main@example.org": 50 },
    factory: "main@example.org",
    keys: ["accounts", "due", "factory", "seen"],
    probes: ["main@example.org", "spare@example.org"],
    rotation: null,
  })
})

test("with no `accounts`, only the factory is probed, as before", () => {
  expect(run("one", { factory: "main@example.org", seen: {} })).toEqual({
    accounts: {},
    factory: "main@example.org",
    keys: ["factory", "seen"],
    probes: ["main@example.org"],
    rotation: null,
  })
})

test("login-flip.json's rotation is what usage.json's `rotation` copies, and any other shape is none", () => {
  const flip = { factory: "main@example.org", seen: {} }
  const pool = [
    {
      account: "main@example.org",
      ending: true,
      endsAt: "2026-11-07T18:30:00+00:00",
      renewsOn: null,
    },
    { account: "spare@example.org", ending: false, endsAt: null, renewsOn: 3 },
  ]
  expect(run("rotation", { ...flip, rotation: { pool } }).rotation).toEqual({ pool })
  expect(
    run("rotation-day", { ...flip, rotation: { pool: [{ ...pool[1], renewsOn: "3" }] } }).rotation,
  ).toBeNull()
  expect(
    run("rotation-day-range", { ...flip, rotation: { pool: [{ ...pool[1], renewsOn: 32 }] } })
      .rotation,
  ).toBeNull()
  expect(
    run("rotation-list", { ...flip, rotation: { pool: ["main@example.org"] } }).rotation,
  ).toBeNull()
  expect(
    run("rotation-bad", { ...flip, rotation: { pool: [{ account: "a", ending: 1 }] } }).rotation,
  ).toBeNull()
})

test("the stored login's reading lands in usage-<local part>.json beside usage.json, and an account of none writes none", () => {
  expect(
    JSON.parse(runRaw("stored", { factory: "main@example.org", seen: {} })[1] ?? "{}"),
  ).toEqual({
    stored: {
      account: "stored@example.org",
      rate_limits: {
        five_hour: { used_percentage: 10, resets_at: 123 },
        seven_day: { used_percentage: 97, resets_at: 456 },
      },
      source: "oauth/usage",
      writtenAt: "2026-10-24T01:00:00Z",
    },
    noNone: true,
  })
})

test("PLAYGROUND_USAGE_API moves the stored login's reads to its own answers, as the new-user gate's box gives them", () => {
  const api = join(scratch, "api")
  mkdirSync(api, { recursive: true })
  writeFileSync(join(api, "profile"), JSON.stringify({ account: { email: "gate@example.com" } }))
  writeFileSync(
    join(api, "usage"),
    JSON.stringify({ seven_day: { resets_at: "2026-11-05T00:00:00+00:00", utilization: 10 } }),
  )
  const read = `
import json, sys, types
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: "made-up", factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
ns["oauth"] = lambda: {"accessToken": "made-up", "expiresAt": 4102444800000}
print(json.dumps(ns["stored_login"]()))
`
  const home = join(scratch, "api-home")
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PLAYGROUND_USAGE_API: `file://${api}`,
  }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(["python3", "-I", "-c", read, script, beat], { env })
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toMatchObject({
    account: "gate@example.com",
    rate_limits: { seven_day: { resets_at: 1793836800, used_percentage: 10 } },
  })
})

// run.py whole, for one cycle, under a scratch HOME: a stand-in beat module in its ops folder records the beat and ends the run, and swaps urllib's urlopen for made-up answers, so no call leaves the Mac; a stand-in `security` holds the Keychain. The stand-in execs the real beat.py first, so the rule's factory_login and has_token are the shipped ones, then overrides beat, checkout and setting
const beatModule = (settings: object) => `
import io, json, os, sys, urllib.error, urllib.request
exec(open(${JSON.stringify(beat)}).read(), globals())
calls = []
def urlopen(req, timeout=None):
    url = req.full_url
    calls.append(url)
    if url.startswith("http://127.0.0.1:9/"):
        five = {} if "/no-5h/" in url else {"anthropic-ratelimit-unified-5h-utilization": "0.95" if "/hot-5h/" in url else "0.2", "anthropic-ratelimit-unified-5h-reset": "4000000000"}
        raise urllib.error.HTTPError(url, 200, "ok", dict(five, **{"anthropic-ratelimit-unified-7d-utilization": "0.3", "anthropic-ratelimit-unified-7d-reset": "4000000000"}), io.BytesIO(b"{}"))
    if url.endswith("/api/oauth/profile"):
        return io.BytesIO(json.dumps({"account": {"email": "stored@example.org"}}).encode())
    if url.endswith("/api/oauth/usage"):
        return io.BytesIO(json.dumps({"seven_day": {"utilization": 70, "resets_at": "2026-11-07T00:00:00+00:00"}}).encode())
    raise OSError("no made-up answer for " + url)
urllib.request.urlopen = urlopen
def checkout():
    return ${JSON.stringify(repo)}
def setting(key):
    return ${JSON.stringify(settings)}[key]
def beat(job, pid, started, cycle, result, extra=None):
    json.dump({"calls": calls, "detail": (extra or {}).get("detail"), "result": result}, open(os.path.join(os.path.dirname(__file__), "beat.json"), "w"))
    os._exit(0)
`

const cycle = async (
  name: string,
  opts: {
    added: string[]
    factory?: string
    login: boolean
    loginExit?: number
    probeUrl?: string
  },
) => {
  const home = join(scratch, name)
  const ops = join(home, ".playground", "ops")
  const stubs = join(home, "stubs")
  mkdirSync(join(ops, "usage"), { recursive: true })
  mkdirSync(stubs, { recursive: true })
  const settings = {
    "models.probe": "a-made-up-model",
    "usage.accounts": [
      ...opts.added.map((email) => ({ email, provider: "claude" })),
      { email: "glm-key", provider: "glm" },
    ],
    "usage.keychainService": "made-up-service",
  }
  writeFileSync(join(ops, "beat.py"), beatModule(settings))
  if (opts.factory)
    writeFileSync(join(ops, "usage", "login-flip.json"), JSON.stringify({ factory: opts.factory }))
  const login = JSON.stringify({
    claudeAiOauth: { accessToken: "made-up", expiresAt: 4_000_000_000_000 },
  })
  writeFileSync(
    join(stubs, "security"),
    `#!/bin/sh\ncase "$*" in\n  *Claude\\ Code-credentials*) ${opts.login ? `echo '${login}'` : `exit ${opts.loginExit ?? 44}`} ;;\n  *made-up-service*) echo made-up-token ;;\n  *) exit 44 ;;\nesac\n`,
    { mode: 0o755 },
  )
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: home,
    PATH: `${stubs}:${process.env.PATH}`,
    PLAYGROUND_PROBE_URL: opts.probeUrl ?? "http://127.0.0.1:9/v1/messages",
  }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawn(["python3", "-I", script], { env, stderr: "pipe" })
  await child.exited
  expect(await new Response(child.stderr).text()).toBe("")
  const read = (path: string) => {
    try {
      return JSON.parse(readFileSync(join(home, ".playground", path), "utf8"))
    } catch {
      return null
    }
  }
  return {
    alerts: read("ops/alerts-usage.json"),
    beat: read("ops/beat.json"),
    usage: read("usage.json"),
  }
}

test("on a fresh install whose only account came through the Dashboard, usage.json holds that account's week and the job reads ok", async () => {
  const { beat, usage } = await cycle("added-only", { added: ["added@example.org"], login: false })
  expect(beat.result).toBe("ok")
  expect(beat.calls).toEqual(["http://127.0.0.1:9/v1/messages"])
  expect(usage.account).toBe("added@example.org")
  expect(usage.rate_limits.seven_day).toEqual({ used_percentage: 30, resets_at: 4_000_000_000 })
})

test("with both a Dashboard account and Claude Code's own login, usage.json holds the Dashboard account's, the login named beside it", async () => {
  const { beat, usage } = await cycle("both", { added: ["added@example.org"], login: true })
  expect(beat.result).toBe("ok")
  expect(usage.account).toBe("added@example.org")
  expect(usage.storedLogin).toEqual({ account: "stored@example.org", week: 70 })
})

test("when the Dashboard account's probe is refused, usage.json holds Claude Code's own login and the job still reads ok", async () => {
  const { beat, usage } = await cycle("refused", {
    added: ["added@example.org"],
    login: true,
    probeUrl: "http://127.0.0.1:8/v1/messages",
  })
  expect(beat.result).toBe("ok")
  expect(beat.detail).toContain("added account: RuntimeError: no reading of added@example.org")
  expect(usage.account).toBe("stored@example.org")
})

test("with Claude Code's own login alone, usage.json holds its reading, as before", async () => {
  const { beat, usage } = await cycle("login-only", { added: [], login: true })
  expect(beat.result).toBe("ok")
  expect(usage.account).toBe("stored@example.org")
})

test("with no account at all, the job beats waiting, not an error, and writes no usage.json", async () => {
  const { beat, usage } = await cycle("none", { added: [], login: false })
  expect(beat.result).toBe("waiting: no Claude account yet; add one in the Dashboard")
  expect(usage).toBeNull()
})

test("while login-flip names the stored login as the factory, usage.json follows that login and no added account is probed", async () => {
  const { beat, usage } = await cycle("factory-is-stored", {
    added: ["added@example.org"],
    factory: "stored@example.org",
    login: true,
  })
  expect(beat.result).toBe("ok")
  expect(beat.calls).not.toContain("http://127.0.0.1:9/v1/messages")
  expect(usage.account).toBe("stored@example.org")
})

test("a Keychain that refuses the read, not one missing the login, fails rather than waits", async () => {
  const { beat } = await cycle("locked", { added: [], login: false, loginExit: 51 })
  expect(beat.result).toBe(
    "error: stored login: RuntimeError: security exited 51 reading Claude Code's credentials",
  )
})

test("an account whose probe answers with no 5-hour headers has no 5-hour window in usage.json, never a 0% one (#85)", async () => {
  const { beat, usage } = await cycle("no-five-hour", {
    added: ["added@example.org"],
    login: false,
    probeUrl: "http://127.0.0.1:9/no-5h/v1/messages",
  })
  expect(beat.result).toBe("ok")
  expect(usage.rate_limits.five_hour).toBeUndefined()
  expect(usage.rate_limits.seven_day).toEqual({ used_percentage: 30, resets_at: 4_000_000_000 })
  expect(beat.detail).toStartWith("added@example.org: 5h none, 7d 30%")
})

// #152: alerts-usage.json carries a week alert for each factory account past a mark, the spares in usage.json's `accounts` included, each naming its account
test("week alerts name each factory account past a mark, a spare's included, and skip an account outside usage.accounts (#152)", () => {
  const home = join(scratch, "week-alerts")
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const read = `
import json, sys, types
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: "made-up", factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
data = {"account": "login@example.org", "rate_limits": {"seven_day": {"used_percentage": 50}}, "writtenAt": "2026-10-31T13:00:00Z",
        "accounts": {"login@example.org": {"week": 50}, "spare@example.org": {"week": 97.5}, "other@example.org": {"week": 99}}}
print(json.dumps([a["line"] for a in ns["week_alerts"](data, ["login@example.org", "spare@example.org"])]))
`
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(["python3", "-I", "-c", read, script, beat], { env })
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([
    "week usage at 97.5% (spare@example.org), past 97%",
  ])
})

// #170: the leads' sweep keys an alert by its kind and name, so each account's alert names that account, or a second account's is hidden while the first one stands
test("two factory accounts past a week mark give two alerts with their own kind and name (#170)", () => {
  const home = join(scratch, "week-alert-names")
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const read = `
import json, sys, types
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: "made-up", factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
data = {"account": "login@example.org", "rate_limits": {"seven_day": {"used_percentage": 92}}, "writtenAt": "2026-10-31T13:00:00Z",
        "accounts": {"spare@example.org": {"week": 97.5}}}
print(json.dumps([f"{a['kind']} {a['name']}" for a in ns["week_alerts"](data, ["login@example.org", "spare@example.org"])]))
`
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(["python3", "-I", "-c", read, script, beat], { env })
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual([
    "usage login@example.org",
    "usage spare@example.org",
  ])
})

test("the 5-hour alert names its account (#170)", async () => {
  const { alerts } = await cycle("hot-5h", {
    added: ["added@example.org"],
    login: false,
    probeUrl: "http://127.0.0.1:9/hot-5h/v1/messages",
  })
  expect(alerts.alerts.map((a: { kind: string; name: string }) => `${a.kind} ${a.name}`)).toEqual([
    "usage-5h added@example.org",
  ])
})

test("a cycle writes the status line's two $ figures from Claude Code's transcripts, at mode 600", async () => {
  await cycle("statusline-cost", { added: ["added@example.org"], login: false })
  const cache = join(scratch, "statusline-cost", ".claude", ".cache")
  for (const name of ["weekly_retail", "daily24_retail", "retail_unpriced"]) {
    expect(readFileSync(join(cache, name), "utf8")).toBe("0")
    expect(statSync(join(cache, name)).mode & 0o777).toBe(0o600)
  }
  expect(
    existsSync(join(scratch, "statusline-cost", ".playground", "ops", "statusline-cost.json")),
  ).toBe(true)
})

// statusline_cost() alone, its CLI swapped for one that fails or outlasts the timeout, beside cache files from an earlier run
const costHarness = `
import json, os, sys, types
beat = {"__name__": "beat", "__file__": sys.argv[4]}
exec(open(sys.argv[4]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "m", "usage.keychainService": "s"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
print(json.dumps(ns["statusline_cost"](sys.argv[2], float(sys.argv[3]))))
`

test.each([
  [
    "exits 1",
    "console.error('made-up failure'); process.exit(1)",
    30,
    "statusline cost: exit 1: made-up failure",
  ],
  ["outlasts its timeout", "await Bun.sleep(5000)", 1, "statusline cost: TimeoutExpired"],
  [
    "fails with a byte that is not UTF-8",
    "process.stderr.write(new Uint8Array([0xff])); process.exit(1)",
    30,
    "statusline cost: exit 1: \ufffd",
  ],
])("a CLI that %s leaves the last figures as they are", (name, body, timeout, problem) => {
  const home = join(scratch, `cost-${name.replace(/ /g, "-")}`)
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const cache = join(home, ".claude", ".cache")
  mkdirSync(cache, { recursive: true })
  writeFileSync(join(cache, "weekly_retail"), "41.5")
  writeFileSync(join(cache, "daily24_retail"), "7.25")
  const fake = join(home, "fake-cli.ts")
  writeFileSync(fake, `${body}\n`)
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", costHarness, script, fake, String(timeout), beat],
    {
      env,
    },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toBe(problem)
  expect(readFileSync(join(cache, "weekly_retail"), "utf8")).toBe("41.5")
  expect(readFileSync(join(cache, "daily24_retail"), "utf8")).toBe("7.25")
})

// #1587: a full week's reading (week 100) stays fresh until its weekReset, so a probe that answers nothing for a full account cannot fail the cycle. Every time is an offset the Python side adds to its own time.time(), so the clock-ahead pass's moved clock cannot split the two; the probe answers None, as it does for a full account whose answer holds no 7d-utilization header
const fullWeekHarness = `
import json, os, sys, time, types
spec = json.loads(sys.argv[3])
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
now = time.time()
calls = []
def probe(email):
    calls.append(email)
    return None if spec.get("probe") is None else dict(spec["probe"], at=now)
ns["probe"] = probe
s = {"at": now + spec["seenAt"], "week": spec["week"]}
if spec.get("weekReset") is not None:
    s["weekReset"] = now + spec["weekReset"]
if spec.get("limitedUntil") is not None:
    s["limitedUntil"] = now + spec["limitedUntil"]
flip = {"accounts": spec.get("accounts") or [], "factory": spec.get("factory"), "seen": {spec["email"]: s}}
ns["write"](ns["FLIP"], flip)
out = {}
try:
    data = ns["factory_reading"]({"account": "mine@example.org", "rate_limits": {}}, flip, (spec.get("accountsList") or [spec["email"]]))
    if data:
        out["factory"] = {"readAt": data["readAt"], "week": data["rate_limits"]["seven_day"]["used_percentage"]}
except Exception as e:
    out["factoryError"] = f"{type(e).__name__}: {e}"
if spec.get("accounts"):
    out["accounts"] = ns["accounts_reading"]()
out["probes"] = calls
print(json.dumps(out))
`

const fullWeek = (name: string, spec: Record<string, unknown>) => {
  const home = join(scratch, name)
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", fullWeekHarness, script, beat, JSON.stringify(spec)],
    { env },
  )
  expect(child.stderr.toString()).toBe("")
  return JSON.parse(child.stdout.toString())
}

test("a full week's reading counts as fresh until its weekReset, so a probe that answers nothing cannot fail the cycle (#1587)", () => {
  expect(
    fullWeek("full-week-fresh", {
      email: "main@example.org",
      factory: "main@example.org",
      seenAt: -3000,
      week: 100,
      weekReset: 2.5 * 86400,
    }),
  ).toEqual({
    factory: { readAt: expect.any(String), week: 100 },
    probes: ["main@example.org"],
  })
})

test("a full week's reading goes stale again once its weekReset has passed (#1587)", () => {
  expect(
    fullWeek("full-week-stale", {
      email: "main@example.org",
      factory: "main@example.org",
      seenAt: -60,
      week: 100,
      weekReset: -3600,
    }),
  ).toEqual({
    factoryError: "RuntimeError: no reading of main@example.org under 30 minutes old",
    probes: [],
  })
})

test("a reading marked limitedUntil is served without probing again until the limit lifts (#1587)", () => {
  expect(
    fullWeek("full-week-limited", {
      email: "main@example.org",
      factory: "main@example.org",
      limitedUntil: 7200,
      seenAt: -3000,
      week: 100,
      weekReset: 2.5 * 86400,
    }),
  ).toEqual({
    factory: { readAt: expect.any(String), week: 100 },
    probes: [],
  })
})

test("accounts_reading keeps a full week's account in the accounts map until its weekReset (#1587)", () => {
  expect(
    fullWeek("full-week-accounts", {
      accounts: ["spare@example.org"],
      email: "spare@example.org",
      seenAt: -3000,
      week: 100,
      weekReset: 2.5 * 86400,
    }),
  ).toEqual({
    accounts: {
      "spare@example.org": { readAt: expect.any(String), week: 100, weekReset: expect.any(Number) },
    },
    probes: ["spare@example.org"],
  })
})

test("accounts_reading writes a limited account's mark into its map entry (#1587)", () => {
  expect(
    fullWeek("limited-map-mark", {
      accounts: ["spare@example.org"],
      email: "spare@example.org",
      limitedUntil: 7200,
      seenAt: -1980,
      week: 40,
      weekReset: 2.5 * 86400,
    }),
  ).toEqual({
    accounts: {
      "spare@example.org": {
        limitedUntil: expect.any(Number),
        readAt: expect.any(String),
        week: 40,
        weekReset: expect.any(Number),
      },
    },
    probes: [],
  })
})

test("a reading limited below 100 is served until its limitedUntil with no probe, and goes stale once the limit passes (#1587)", () => {
  // a full 5-hour window marked limitedUntil hours ahead: seen() holds the probe, so the reading stays fresh that long
  expect(
    fullWeek("limited-below-100-fresh", {
      email: "main@example.org",
      factory: "main@example.org",
      limitedUntil: 7200,
      seenAt: -1980,
      week: 40,
    }),
  ).toEqual({
    factory: { readAt: expect.any(String), week: 40 },
    probes: [],
  })
  // the limit has passed: the probe runs again and its fresh reading is served
  expect(
    fullWeek("limited-below-100-stale", {
      email: "main@example.org",
      factory: "main@example.org",
      limitedUntil: -60,
      probe: { five: 20, fiveReset: 4102444800, week: 41, weekReset: 4102444800 },
      seenAt: -1980,
      week: 40,
    }),
  ).toEqual({
    factory: { readAt: expect.any(String), week: 41 },
    probes: ["main@example.org"],
  })
})

// run.py's own probe(), with urlopen raising the made-up 429 and its headers holding no status header, so a full week is marked limited until its reset whatever the status header says (#1587)
const probeHarness = `
import io, json, sys, time, types, urllib.error, urllib.request
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
spec = json.loads(sys.argv[3])
ns["subprocess"] = types.SimpleNamespace(run=lambda *a, **k: types.SimpleNamespace(returncode=0, stdout="made-up-token\\n", stderr=""))
def urlopen(req, timeout=None):
    raise urllib.error.HTTPError(req.full_url, 429, "rate limited", spec["headers"], io.BytesIO(b"{}"))
urllib.request.urlopen = urlopen
print(json.dumps(ns["probe"](spec["email"])))
`

test("run.py's probe marks a full week limited until its weekReset, with no status header in the answer (#1587)", () => {
  const home = join(scratch, "probe-limited")
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(
    [
      "python3",
      "-I",
      "-c",
      probeHarness,
      script,
      beat,
      JSON.stringify({
        email: "full@example.org",
        headers: {
          "anthropic-ratelimit-unified-7d-reset": "4102444800",
          "anthropic-ratelimit-unified-7d-utilization": "1.0",
        },
      }),
    ],
    { env },
  )
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString())).toEqual({
    five: null,
    fiveReset: null,
    limitedUntil: 4102444800,
    week: 100,
    weekReset: 4102444800,
  })
})

// #1587: a full-week reading freezes its 5-hour figure, so one whose window has reset counts as none in use and no slow-spawns alert rides it
const fiveHarness = `
import json, os, sys, time, types
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
now = time.time()
s = {"at": now - 3000, "five": 95, "fiveReset": now - 7200, "week": 100, "weekReset": now + 2 * 86400, "limitedUntil": now + 2 * 86400}
print(json.dumps(ns["probed"]("full@example.org", s, {"account": "mine@example.org", "rate_limits": {}}, now)))
`

test("a frozen 5-hour figure past its reset counts as none in use, so no slow-spawns alert rides it (#1587)", () => {
  const home = join(scratch, "five-past-reset")
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(["python3", "-I", "-c", fiveHarness, script, beat], { env })
  expect(child.stderr.toString()).toBe("")
  expect(JSON.parse(child.stdout.toString()).rate_limits.five_hour).toEqual({
    resets_at: expect.any(Number),
    used_percentage: 0,
  })
})

// #1587: factory_reading against a fake accounts list, its reading 42 minutes old with a week under 100, so a none can only come from the list check and not from freshness. The probe and the Keychain are stubbed, so no request leaves the Mac
const unlistedHarness = `
import json, os, sys, time, types
spec = json.loads(sys.argv[3])
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
now = time.time()
ns["probe"] = lambda e: None
ns["subprocess"] = types.SimpleNamespace(run=lambda *a, **k: types.SimpleNamespace(returncode=1, stdout="", stderr=""))
flip = {"factory": "gone@example.test", "seen": {"gone@example.test": {"at": now + spec["seenAt"], "week": spec["week"], "weekReset": now + 2 * 86400}}}
out = {}
try:
    data = ns["factory_reading"]({"account": "mine@example.test", "rate_limits": {}}, flip, spec["accounts"])
    if data:
        out["factory"] = data["account"]
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"
print(json.dumps(out))
`

const runUnlisted = (name: string, spec: Record<string, unknown>) => {
  const home = join(scratch, name)
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", unlistedHarness, script, beat, JSON.stringify(spec)],
    { env },
  )
  expect(child.stderr.toString()).toBe("")
  return JSON.parse(child.stdout.toString())
}

test("factory_reading returns none, and does not raise, when the factory names an account usage.accounts no longer lists (#1587)", () => {
  expect(
    runUnlisted("factory-unlisted", {
      accounts: ["mine@example.test"],
      seenAt: -2520,
      week: 40,
    }),
  ).toEqual({})
})

test("a settings read that fails keeps the factory's reading, since no account is known to be removed (#1587)", () => {
  expect(runUnlisted("factory-unknown-list", { accounts: null, seenAt: -60, week: 40 })).toEqual({
    factory: "gone@example.test",
  })
})

// the pool rule both readers share (beat.factory_login): factory_reading reads the field through it, the token read the validity test. The Keychain answers by spec.tokens and the probe by spec.dead, so no request leaves the Mac
const poolHarness = `
import json, os, sys, time, types
spec = json.loads(sys.argv[3])
beat = {"__name__": "beat", "__file__": sys.argv[2]}
exec(open(sys.argv[2]).read(), beat)
sys.modules["beat"] = types.SimpleNamespace(beat=lambda *a, **k: None, checkout=lambda: "/no-checkout", setting=lambda key: {"models.probe": "a-made-up-model", "usage.accounts": [], "usage.keychainService": "made-up-service"}[key], factory_login=beat["factory_login"], has_token=beat["has_token"])
src = open(sys.argv[1]).read()
ns = {"__name__": "run_under_test"}
exec(compile(src[: src.index("\\nwhile True:")], sys.argv[1], "exec"), ns)
now = time.time()
calls = []
def probe(email):
    calls.append(email)
    if email in (spec.get("dead") or []):
        return None
    return {"five": 10, "fiveReset": now + 3600, "week": 40, "weekReset": now + 86400}
ns["probe"] = probe
tokens = set(spec.get("tokens") or ())
def keychain(cmd, *a, **k):
    return types.SimpleNamespace(returncode=0 if "-a" in cmd and cmd[cmd.index("-a") + 1] in tokens else 1, stdout="", stderr="")
keychain_module = types.SimpleNamespace(run=keychain)
ns["subprocess"] = keychain_module
beat["subprocess"] = keychain_module
flip = {"factory": spec["factory"],
        "rotation": {"pool": [{"account": a, "ending": False, "endsAt": None, "renewsOn": None} for a in spec["pool"]]},
        "seen": {a: {"at": now + v.get("at", -60), "week": v.get("week", 40), "weekReset": now + 2 * 86400} for a, v in spec["seen"].items()},
        "split": {"at": now, "shares": spec["shares"]}}
out = {}
try:
    data = ns["factory_reading"]({"account": "stored@example.test", "rate_limits": {}}, flip, spec["accounts"])
    if data:
        out["factory"] = data["account"]
except Exception as e:
    out["error"] = f"{type(e).__name__}: {e}"
out["probes"] = calls
print(json.dumps(out))
`

const runPool = (name: string, spec: Record<string, unknown>) => {
  const home = join(scratch, name)
  mkdirSync(join(home, ".playground", "ops", "usage"), { recursive: true })
  const env: Record<string, string | undefined> = { ...process.env, HOME: home }
  delete env.CLAUDE_CONFIG_DIR
  const child = Bun.spawnSync(
    ["python3", "-I", "-c", poolHarness, script, beat, JSON.stringify(spec)],
    {
      env,
    },
  )
  expect(child.stderr.toString()).toBe("")
  return JSON.parse(child.stdout.toString())
}

test("a factory that has left the pool falls back to the pool account the split gives the best share (#1751)", () => {
  expect(
    runPool("pool-left", {
      accounts: ["mine@example.test", "spare@example.test"],
      factory: "gone@example.test",
      pool: ["mine@example.test", "spare@example.test"],
      seen: { "spare@example.test": {} },
      shares: { "mine@example.test": 0.2, "spare@example.test": 0.8 },
      tokens: ["mine@example.test", "spare@example.test"],
    }),
  ).toEqual({ factory: "spare@example.test", probes: [] })
})

// the same fixture login-flip.test.ts's token-gone row feeds its reader: five accounts, four tokens, the same shares, and both readers resolve to the best tokened share
test("a pool factory whose token reads no more falls back to the pool account the split gives the best share (#1751)", () => {
  expect(
    runPool("pool-token-gone", {
      accounts: [
        "lw@example.test",
        "nd@example.test",
        "own@example.test",
        "own2@example.test",
        "pride@example.test",
      ],
      factory: "pride@example.test",
      pool: [
        "lw@example.test",
        "nd@example.test",
        "own@example.test",
        "own2@example.test",
        "pride@example.test",
      ],
      seen: {
        "lw@example.test": { week: 100 },
        "nd@example.test": { week: 100 },
        "own@example.test": {},
        "own2@example.test": { week: 100 },
        "pride@example.test": { week: 50 },
      },
      shares: {
        "lw@example.test": 0,
        "nd@example.test": 0.2,
        "own@example.test": 0.3,
        "own2@example.test": 0,
        "pride@example.test": 0.5,
      },
      tokens: ["lw@example.test", "nd@example.test", "own@example.test", "own2@example.test"],
    }),
  ).toEqual({ factory: "own@example.test", probes: [] })
})

test("a pool factory whose token still reads keeps the factory and fails on its stale reading, as before (#1751)", () => {
  expect(
    runPool("pool-token-holds", {
      accounts: ["mine@example.test", "spare@example.test"],
      dead: ["mine@example.test"],
      factory: "mine@example.test",
      pool: ["mine@example.test", "spare@example.test"],
      seen: { "mine@example.test": { at: -2000 }, "spare@example.test": {} },
      shares: { "mine@example.test": 0.8, "spare@example.test": 0.2 },
      tokens: ["mine@example.test", "spare@example.test"],
    }),
  ).toEqual({
    error: "RuntimeError: no reading of mine@example.test under 30 minutes old",
    probes: ["mine@example.test"],
  })
})

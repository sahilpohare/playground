#!/usr/bin/env python3
"""ops-merge-train: merge-on-ready as a script ops job, no model, no session; Ops runs it, and it shows under Runners.

Every CYCLE seconds, in its own worktree reset to origin/canary (.claude/worktrees/train), it runs `bun run pr:train ready`, which merges,
through pr:merge, the first PR in queue order whose every gate passes at its head, GitHub's checks there included; one merge a cycle, and a
cycle whose open PRs and canary are unchanged since the last scan merges nothing.
Single instance (flock); the heartbeat (ops-merge-train.json) beats from a thread.
"""
import fcntl, json, os, subprocess, sys, threading, time

HERE = os.path.join((os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path")), "ops", "merge-train")  # the state folder by name, so a run by its repo path still reads the live state
OPS = os.path.dirname(HERE)
sys.path.insert(0, OPS)
from beat import beat, checkout, gh_down  # noqa: E402

ROOT = checkout()
WT = os.path.join(ROOT, ".claude", "worktrees", "train")
NO_READY = os.path.join(HERE, "no-ready")  # a file here pauses merge-on-ready
STARTED = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

lock = open(os.path.join(HERE, "run.lock"), "w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit("ops-merge-train is already running")


def setting(key):
    """A setting's value as the store's reader in the factory's checkout prints it (packages/scripts/src/playground/setting.ts), its default on a machine with no store."""
    r = subprocess.run(["bun", os.path.join(ROOT, "packages", "scripts", "src", "playground", "setting.ts"), key], capture_output=True, text=True, timeout=60)
    if r.returncode != 0:
        raise SystemExit(f"ops-merge-train: {key}: {r.stderr.strip() or f'exit {r.returncode}'}")
    return json.loads(r.stdout)


REPO = setting("factory.repo")
CYCLE = setting("jobs.opsMergeTrain")["schedule"].get("every", 60)  # the job's own schedule, so moving it is a settings write
state = {"result": "ok", "detail": "starting", "rebuild_now": True}


def load_json(path, default):
    try:
        return json.load(open(path))
    except Exception:
        return default


def clean_env():
    env = dict(os.environ)
    env.pop("NODE_ENV", None)
    env.pop("SKIP_ENV_VALIDATION", None)
    return env


def owner(n):
    """The session to tell about PR n: the live roster agent whose pr is it, a worker first."""
    agents = [a for a in load_json(os.path.join(os.path.dirname(OPS), "roster.json"), {}).get("agents", []) if str(a.get("pr", "")).rstrip("/").endswith(f"/pull/{n}") and a.get("status") != "ended"]
    agents.sort(key=lambda a: not a["name"].startswith("worker-"))
    return agents[0]["name"] if agents else None


def tell_owner(n, text):
    """Type the merge line into the PR's own session (notify.sh types only into an empty input box)."""
    who = owner(n)
    if who:
        subprocess.Popen([os.path.join(OPS, "notify.sh"), "merge-train", text], env={**os.environ, "NOTIFY_TO": who}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def notify(msg):
    subprocess.run([os.path.join(OPS, "notify.sh"), "merge-train", msg])


def log(line):
    with open(os.path.join(HERE, "train.log"), "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {line}\n")


def heartbeat():
    while True:
        try:
            beat("ops-merge-train", os.getpid(), STARTED, CYCLE, state["result"], {"detail": state["detail"]})
        except Exception:
            pass
        time.sleep(30)


def sh(argv, timeout=900):
    r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, cwd=WT, env=clean_env())
    return r.returncode, (r.stdout or ""), (r.stderr or "")


def train(*args, timeout=900):
    code, out, err = sh(["bun", "run", "--silent", "pr:train", *args], timeout=timeout)
    return code, out.strip(), err.strip()


def first_error(text):
    return next((l.strip() for l in text.splitlines() if l.strip()), "")[:110]


def sync():
    """The train's worktree follows origin/canary, so pr:train is the code canary carries; install when the lockfile moved, build the packages when the reset moved any (a merged PR's new export has no dist until built: the train stopped on a PR's verdicts, 23:02Z)."""
    _, before, _ = sh(["git", "rev-parse", "HEAD"])
    sh(["git", "fetch", "-q", "origin", "canary"], timeout=300)
    sh(["git", "reset", "-q", "--hard", "origin/canary"])
    code, _, _ = sh(["git", "diff", "--quiet", before.strip(), "HEAD", "--", "bun.lock"])
    if code:
        sh(["bun", "install", "--frozen-lockfile", "--ignore-scripts"], timeout=900)
    code, _, _ = sh(["git", "diff", "--quiet", before.strip(), "HEAD", "--", "packages"])
    if code:
        sh(["bun", "run", "turbo", "run", "build", "--filter=./packages/*"], timeout=900)


def tell_lead(text):
    # builder, 20 Oct: an auto-merge sends "merged #N <sha>" so the queue's overlap check runs at once
    subprocess.Popen([os.path.join(OPS, "notify.sh"), "merge-train", text], env={**os.environ, "NOTIFY_TO": "builder"}, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True)


def merge_ready():
    """Merge-on-ready: `pr:train ready` merges, through pr:merge, the first PR in queue order whose every gate passes at its head.
    One merge per call; returns a detail, or None."""
    if os.path.exists(NO_READY):
        return None
    code, out, err = train("ready", "--json", timeout=900)
    if code:
        log(f"merge-on-ready: pr:train ready exited {code}: {first_error(err or out)}")
        return None
    try:
        merged = json.loads(out[out.index("{"):]).get("merged")
    except ValueError:
        return None
    if not merged:
        return None
    n, sha = merged["n"], merged["sha"]
    log(f"merge-on-ready #{n} at {sha[:7]}: {merged.get('why', '')}")
    tell_owner(n, f"#{n}: merged on ready as {sha[:7]}")
    tell_lead(f"merged #{n} {sha[:7]} (merge-on-ready)")
    state["rebuild_now"] = True
    return f"merged #{n} on ready as {sha[:7]}"


def fingerprint():
    """What a scan depends on: canary's head (git, no API) and each open PR's number, head, update time and checks (one GraphQL call), since a check run that finishes leaves updatedAt as it was. None on failure."""
    code, out, err = sh(["gh", "pr", "list", "--repo", REPO, "--state", "open", "--limit", "100", "--json", "number,headRefOid,updatedAt,isDraft,statusCheckRollup"], timeout=60)
    if code:
        if "rate limit" in (err + out).lower():
            raise RateLimited(err or out)
        return None
    _, canary, _ = sh(["git", "rev-parse", "origin/canary"])
    checks = lambda p: ",".join(sorted(f"{c.get('name') or c.get('context')}={c.get('conclusion') or c.get('state') or c.get('status')}" for c in p.get("statusCheckRollup") or []))
    return canary.strip() + "|" + "|".join(sorted(f"{p['number']}:{p['headRefOid'][:12]}:{p['updatedAt']}:{p['isDraft']}:{checks(p)}" for p in json.loads(out or "[]")))


class RateLimited(Exception):
    pass


def graphql_reset():
    """Seconds until the GraphQL window resets (gh api rate_limit is free of charge), at least 60 and at most an hour."""
    code, out, _ = sh(["gh", "api", "rate_limit", "--jq", ".resources.graphql.reset"], timeout=30)
    try:
        return max(60, min(3600, int(out.strip()) - int(time.time()) + 5))
    except ValueError:
        return 600


def cycle():
    sync()
    down = gh_down()
    if down:
        return "ok", f"skipped: gh unreachable: {down}, next cycle"
    # GitHub's GraphQL budget (5000/h, shared by the whole factory) went on scanning every open PR every minute (8 Oct): scan only when an
    # open PR's head or update time, or canary, changed since the last scan; one cheap list call per cycle decides
    fp = fingerprint()
    if fp is None:
        return "ok", "skipped: could not list PRs (GitHub API), next cycle"
    if fp == state.get("fingerprint") and not state["rebuild_now"]:
        return "ok", "nothing changed since the last scan"
    state["fingerprint"], state["rebuild_now"] = fp, False
    merged = merge_ready()
    if merged:
        return "ok", merged
    return "ok", "merge-on-ready paused (no-ready)" if os.path.exists(NO_READY) else "no PR ready to merge"


threading.Thread(target=heartbeat, daemon=True).start()
log("ops-merge-train armed")
failures = 0
while True:
    try:
        state["result"], state["detail"] = cycle()
        if "rate limit" in (state["result"] + state["detail"]).lower():
            raise RateLimited(state["result"])
    except RateLimited:
        # back off until GitHub's GraphQL window resets, rather than spend the next window's first calls retrying (builder, 8 Oct)
        wait = graphql_reset()
        until = time.strftime("%H:%M:%SZ", time.gmtime(time.time() + wait))
        state["result"], state["detail"] = "ok", f"GitHub GraphQL rate limit: backing off until {until}"
        log(state["detail"])
        try:
            beat("ops-merge-train", os.getpid(), STARTED, CYCLE, state["result"], {"detail": state["detail"]})
        except Exception:
            pass
        time.sleep(wait)
        continue
    except Exception as e:
        state["result"], state["detail"] = f"error: {type(e).__name__}: {e}"[:120], ""
    if state["result"].startswith("error"):
        failures += 1
        log(state["result"])
        if failures in (2, 10):
            notify(f"merge train: {state['result']}")
    else:
        failures = 0
    try:
        beat("ops-merge-train", os.getpid(), STARTED, CYCLE, state["result"], {"detail": state["detail"]})
    except Exception:
        pass
    time.sleep(CYCLE)

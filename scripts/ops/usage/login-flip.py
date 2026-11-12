#!/usr/bin/env python3
"""login-flip.py: say when the factory should move to another Claude account, and to which (dispatcher, 14 Oct:
the switch is the factory's, never an ask to the owner). It reads usage.json, which follows the stored login, and reads each other
account in ACCOUNTS that has a long-lived token in the Keychain (service usage.keychainService) from one 1-token call's rate-limit
headers, at most every 14 minutes. The current account reads through the pool rule beat.factory_login carries: login-flip.json's `factory` while it is a pool
account whose token is still in the Keychain, else the pool account the split gives the best share, else the stored login. Ending accounts (ENDS) come first: the first usable one in ending_order() is the target whenever
the factory is on another account; with none usable, once the current login reaches its line, the renewing account with MIN_ROOM
whose week resets soonest. It names the target once ("switch due to ..."), or says once that no account has room. Prints nothing otherwise.
It also writes the split, each account's share of new sessions (week left per hour to its deadline, a fifth of that for an own account while that deadline is over a day away, none for one parked until a later time), which spawn.sh's no-account default follows. --dry-run reads no token and changes nothing. State in login-flip.json in the state folder, the data folder's ops/usage."""
import datetime, json, os, shutil, subprocess, sys, time

HERE = os.path.join((os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path")), "ops", "usage")  # the state folder by name, so a run by its repo path still reads the live state
sys.path.insert(0, os.path.dirname(HERE))
from beat import OPS, checkout, factory_login, setting  # noqa: E402

# the stored login's own reading: usage.json names the account the factory spends (its `factory` key below), which may be another
STORED = os.path.join(HERE, "stored-login.json")
USAGE = STORED if os.path.exists(STORED) else os.path.join(os.path.dirname(OPS), "usage.json")
STATE = os.path.join(HERE, "login-flip.json")
DASHBOARD = os.path.join(checkout(), ".claude", "worktrees", "desk")
BUN = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
DRY = "--dry-run" in sys.argv
# the factory's Claude accounts, in usage.accounts' order: every one is in the rotation
ROWS = [a for a in setting("usage.accounts") if a.get("provider", "claude") == "claude"]
ACCOUNTS = [a["email"] for a in ROWS]
TARGETS = list(ACCOUNTS)
FIVE_H_AT, WEEK_AT, WARN_AT = 80, 99, 97  # #i375: an account is used to 99% of its week before the switch; the switch targets are TARGETS
SPAWN = os.path.join(checkout(), "scripts", "spawn.sh")
SERVICE, PROBE_EVERY = setting("usage.keychainService"), 840
MIN_ROOM = 10  # dispatcher, 25 Oct: a switch restarts every session, so a renewing target needs 10 week points left before WEEK_AT (week at most 89)
# dispatcher, 25 Oct: the accounts whose plan ends, each with its end (None until known), spent to 100% and out ENDS_LEAD before it, ENDING_FIRST leading; every other account renews
ENDS = {a["email"]: a["ends"] for a in ROWS if "ends" in a}
ENDING_FIRST, ENDS_LEAD = [a["email"] for a in ROWS if a.get("endsFirst")], 2 * 3600
RENEWS = {a["email"]: a["renews"] for a in ROWS if "renews" in a}  # each renewing account's billing day of the month (None until known), for the dashboard's Renews lines
# the owner, 3 Nov: the accounts the owner pays for personally (own) are spent less, a fifth of their weight, unless their deadline is within a day, so their week left is still spent before it resets
OWN, OWN_SHARE, OWN_SOON = {a["email"] for a in ROWS if a.get("own")}, 0.2, 24 * 3600
# an account parked until a time (parkedUntil) takes no new session before it, so its week is kept, e.g. for the owner until its reset
PARKED = {a["email"]: datetime.datetime.fromisoformat(a["parkedUntil"].replace("Z", "+00:00")).timestamp() for a in ROWS if a.get("parkedUntil")}
PROBE_MODEL = setting("models.probe")


def probe(email):
    """An account with a long-lived token in the Keychain (#i338) but not the stored login: one 1-token call to models.probe, whose
    rate-limit headers give its 5-hour and week use (a setup-token has the inference scope alone, so the usage endpoint refuses it).
    The token goes from the Keychain into the request header and nowhere else."""
    r = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", email, "-w"], capture_output=True, text=True, timeout=15)
    if r.returncode or DRY:
        return None
    import urllib.request
    body = json.dumps({"model": PROBE_MODEL, "max_tokens": 1, "system": "You are Claude Code, Anthropic's official CLI for Claude.",
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "Authorization": "Bearer " + r.stdout.strip(), "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            h = resp.headers
    except Exception as e:
        h = getattr(e, "headers", None)
    if not h or h.get("anthropic-ratelimit-unified-7d-utilization") is None:
        return None
    f = lambda k: float(h.get(f"anthropic-ratelimit-unified-{k}") or 0)
    # no 5-hour headers: an account with no 5-hour limit, so none, never 0%
    five = h.get("anthropic-ratelimit-unified-5h-utilization") is not None
    got = {"five": round(f("5h-utilization") * 100) if five else None, "fiveReset": f("5h-reset") if five else None, "week": round(f("7d-utilization") * 100), "weekReset": f("7d-reset")}
    # dispatcher, 16 Oct: a limited account is read once and not again until its reset ("never retry, never fall back to another account")
    if got["week"] >= 100:
        got["limitedUntil"] = got["weekReset"]  # a full week is limited until its reset, whatever the status header says
    elif h.get("anthropic-ratelimit-unified-status") == "rejected":
        got["limitedUntil"] = got["weekReset"] if (got["five"] or 0) < 100 else got["fiveReset"]
    return got


def dashboard_ask(*args, stdin=None):
    if DRY:
        print("would run: bun run ask", *args, stdin or "")
        return 0, "dry-run"
    env = dict(os.environ, PATH=os.pathsep.join([os.path.dirname(BUN), "/usr/local/bin", "/opt/homebrew/bin", os.environ.get("PATH", "/usr/bin:/bin")]))
    r = subprocess.run([BUN, "run", "--cwd", DASHBOARD, "ask", *args], input=stdin, capture_output=True, text=True, timeout=120, env=env)
    return r.returncode, r.stdout.strip().splitlines()[-1] if r.stdout.strip() else r.stderr.strip()[-200:]


# login-flip.off-until holds an ISO time with its zone; until then it prints nothing and reads no other account (dispatcher, 20 Oct: one login today, #i584's stop and resume in place of a switch)
try:
    if datetime.datetime.fromisoformat(open(os.path.join(HERE, "login-flip.off-until")).read().strip()).timestamp() > time.time():
        sys.exit(0)
except (OSError, ValueError):
    pass

u = json.load(open(USAGE))
acct = u.get("account")
rl = u.get("rate_limits") or {}
five, week = rl.get("five_hour") or {}, rl.get("seven_day") or {}
try:
    state = json.load(open(STATE))
except (OSError, ValueError):
    state = {}
now = time.time()
seen = state.setdefault("seen", {})
current = factory_login(state.get("factory"), ACCOUNTS, (state.get("split") or {}).get("shares") or {}, SERVICE) or acct  # the account the factory's sessions run on (spawn.sh --account), the pool rule beat.py carries
# a usage.json run.py took from a probe already came from seen, and stamping it again would stop run.py's next probe
if acct in ACCOUNTS and u.get("source") != "token/ratelimit-headers":
    last, seen[acct] = seen.get(acct) or {}, {"at": now}
    for key, win in (("five", five), ("week", week)):  # a window the reading lacks keeps its last one, so a short read is no switch
        fresh = win.get("used_percentage") is not None
        seen[acct][key], seen[acct][key + "Reset"] = (win.get("used_percentage"), win.get("resets_at")) if fresh else (last.get(key), last.get(key + "Reset"))
    # a week with no 5-hour window is an account with no 5-hour limit, so none rather than the last reading's
    if "five_hour" not in rl and week.get("used_percentage") is not None:
        seen[acct]["five"], seen[acct]["fiveReset"] = None, None
for other in ACCOUNTS:
    if other != acct and now - (seen.get(other) or {}).get("at", 0) >= PROBE_EVERY and now >= (seen.get(other) or {}).get("limitedUntil", 0):
        got = probe(other)
        if got:
            seen[other] = dict(got, at=now, via="token")

open_ask = state.get("ask")
if open_ask and acct == open_ask["to"]:
    state.pop("ask")
    print(f"login flip: the machine is now on {acct}; ask {open_ask['id']} done (ops acks it when the owner approves)")
    open_ask = None

if open_ask and acct != open_ask["to"] and (five.get("used_percentage") or 0) < FIVE_H_AT - 30:
    code, out = dashboard_ask("settle", open_ask["id"], "--note", f"No longer needed: {acct}'s 5-hour window reset ({five.get('used_percentage')}% now)")
    if code == 0:
        state.pop("ask")
        print(f"login flip: settled ask {open_ask['id']}: {acct}'s 5-hour window reset before the switch")
        open_ask = None

if state.get("due") and current == state["due"]:
    state.pop("due")
    print(f"login flip: the factory is now on {current}")

def room(a):
    s = seen.get(a) or {}
    if s.get("week") is None or (s.get("weekReset") and now >= s["weekReset"]):
        return 100 if s.get("weekReset") and now >= s["weekReset"] else None
    if WEEK_AT - s["week"] < MIN_ROOM or ((s.get("five") or 0) >= FIVE_H_AT and not (s.get("fiveReset") and now >= s["fiveReset"])):
        return None
    return WEEK_AT - s["week"]


# dispatcher, 25 Oct: soonest week reset first, so leftover week is spent before it expires; one past its reset resets a week later, and one with no reset time goes last
def resets(a):
    at = (seen.get(a) or {}).get("weekReset")
    return float("inf") if not at else at + 7 * 86400 if now >= at else at


def ends_at(a):
    return datetime.datetime.fromisoformat(ENDS[a]).timestamp() if ENDS.get(a) else None


def usable(a):
    """An account: not parked, not within ENDS_LEAD of its end, not refused, its week under 100% and its 5-hour window under FIVE_H_AT or reset."""
    s, end = seen.get(a) or {}, ends_at(a)
    if now < PARKED.get(a, 0) or (end is not None and now >= end - ENDS_LEAD) or now < s.get("limitedUntil", 0):
        return False
    if s.get("weekReset") and now >= s["weekReset"]:
        week = 0
    elif s.get("week") is None:
        return False
    else:
        week = s["week"]
    return week < 100 and ((s.get("five") or 0) < FIVE_H_AT or bool(s.get("fiveReset") and now >= s["fiveReset"]))


def weight(a):
    """Week points left per hour to the account's deadline: its week reset or, for an ending account, ENDS_LEAD before its end, whichever comes first, an own account's OWN_SHARE of that while its deadline is over OWN_SOON away; 0 when it is not usable (a parked one included) or its deadline is unknown or past."""
    end, reset = ends_at(a), resets(a)
    deadline = min(reset, end - ENDS_LEAD) if end is not None else reset
    if not usable(a) or not now < deadline < float("inf"):
        return 0
    s = seen.get(a) or {}
    week = 0 if s.get("weekReset") and now >= s["weekReset"] else s["week"]
    pace = (100 - week) / ((deadline - now) / 3600)
    return pace * OWN_SHARE if a in OWN and deadline - now > OWN_SOON else pace


def ending_order():
    rest = sorted((a for a in ENDS if a not in ENDING_FIRST), key=resets)
    return [a for a in ENDING_FIRST + rest if a in TARGETS]


def account_live():
    """Whether the main checkout's spawn.sh can start a session on a stored token yet (swift-key's --account PR, shipped to main)."""
    try:
        return "--account" in open(SPAWN).read()
    except OSError:
        return False


# dispatcher, 14 Oct: at 97% on an account the factory may switch to, say so once per week reset
told = state.setdefault("warned", {})
for a in TARGETS:
    w = seen.get(a) or {}
    # by the hour: /usage's reset times drift by a second between reads, which must not repeat the warning
    if (w.get("week") or 0) >= WARN_AT and round((told.get(a) or 0) / 3600) != round((w.get("weekReset", w.get("fiveReset")) or 0) / 3600):
        told[a] = w.get("weekReset", w.get("fiveReset"))
        print(f"login flip: {a} week at {w.get('week')}%, past {WARN_AT}%; it stops at 100%.")

# dispatcher, 25 Oct: an ending account is said once until its end is set
noted = state.setdefault("noEnd", [])
for a in ENDS:
    if not ENDS[a] and a not in noted:
        noted.append(a)
        print(f"login flip: {a}'s plan ends but usage.accounts sets no end, so it stays in the rotation until its week reaches 100%")

# the first usable ending account is the target whenever the factory is elsewhere (a block moves on, a cleared one moves back); with none, once current is spent, a renewing one with MIN_ROOM
target, due, c = None, False, seen.get(current) or {}
if current in ACCOUNTS:
    first = next((a for a in ending_order() if usable(a)), None)
    spent = not usable(current) if current in ENDS else (c.get("five") or 0) >= FIVE_H_AT or (c.get("week") or 0) >= WEEK_AT
    if first and first != current:
        target, due = first, True
    elif spent:
        rooms = sorted((resets(a), -room(a), a) for a in TARGETS if a not in ENDS and a != current and room(a) is not None)
        target, due = (rooms[0][2] if rooms else None), True
if due:
    why = f"{current} 5-hour {c.get('five')}%, week {c.get('week')}%"
    if target and not open_ask and state.get("due") != target:
        # dispatcher, 14 Oct (#i338): the switch runs through the factory's terminal and never an ask to the owner; this only says it is due
        state["due"] = target
        kind = "ending" if target in ENDS else "renewing"
        print(f"login flip: switch due to {target} ({kind}, week {(seen.get(target) or {}).get('week')}%): {why}; the factory switches (no ask to the owner); " + ("spawn.sh --account is live on main" if account_live() else "spawn.sh --account is NOT on main yet, so the switch cannot start"))
    elif not target and state.get("due") != "none":
        state["due"] = "none"
        print(f"login flip: switch due but no account has room: {why}; " + ", ".join(f"{a} week {(seen.get(a) or {}).get('week')}%" for a in TARGETS if a != current))
else:
    state.pop("due", None)  # nothing due now, so the next due switch is said again, even to the same target

# each account's share of new sessions is its weight over the pool's, so every subscription is spent before its deadline and none is wasted; spawn.sh's no-account default follows it
weights = {a: weight(a) for a in TARGETS}
total = sum(weights.values())
state["split"] = {"at": now, "shares": {a: w / total if total else 0 for a, w in weights.items()}}

# an account that leaves the pool drops out of `accounts`, so its readers probe and count pool accounts alone
if "accounts" in state:
    state["accounts"] = [a for a in state["accounts"] if a in TARGETS]

# the rotation as data, so ops-usage copies it into usage.json for the dashboard's usage tooltip
state["rotation"] = {"pool": [{"account": a, "ending": a in ENDS, "endsAt": ENDS.get(a), "renewsOn": RENEWS.get(a)} for a in TARGETS]}
if not DRY:
    tmp = f"{STATE}.{os.getpid()}"
    json.dump(state, open(tmp, "w"))
    os.replace(tmp, STATE)

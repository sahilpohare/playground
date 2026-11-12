#!/usr/bin/env python3
"""ops-usage: the usage windows of the account the factory spends into ~/.playground/usage.json, every 5 minutes, so the dashboard's
footer and tooltip read the account the sessions really run on, never a stale one.

The stored login (Claude Code's keychain item "Claude Code-credentials") is read from the endpoint Claude Code's /usage reads
(api.anthropic.com/api/oauth/usage) into usage/stored-login.json, which login-flip.py reads, and into usage-<local part>.json beside
usage.json, the file the dashboard's Week tooltip reads. It never refreshes that token (a refresh
rotates the refresh token Claude Code holds); an expired one waits for Claude Code to refresh it.
login-flip.json's `factory` login reads through the pool rule beat.factory_login carries: itself while the pool still lists it and its
token still reads (has_token's Keychain check), else the pool account the split gives the best share. While that login is an account other than the stored login (the
factory's sessions run on its token, spawn.sh --account), usage.json holds that account's limits instead: login-flip's own reading of it, from one 1-token call's
rate-limit headers (a setup-token's inference scope cannot read /usage), taken here when login-flip's is 14 minutes old or more and its
limitedUntil has passed, and shared through login-flip.json, so the two never probe the same account twice in that time. usage.json then adds `readAt` (when the
limits were measured), `source` "token/ratelimit-headers" and `storedLogin` (the stored login's account and week). Remove `factory`
from login-flip.json when the factory moves back to the stored login. login-flip.json's `accounts` lists every pool account the factory's
sessions spend into, login-flip.py pruning it to the pool on each run; each is probed the same way, and usage.json's `accounts` holds each fresh week reading, which week-marks.py sums.
ops/alerts-usage.json holds, while each lasts, one alert per factory account whose week is past 90, 97 or 98% (usage.json's account
and each in its `accounts`), and the logged-in account's 5-hour window at 90% or more; ops-unstick folds it in.
Each alert's `name` is its account, since the leads' sweep keys an alert by its kind and name.
While login-flip.json's `factory` resolves to no account, each Claude account the Dashboard's Add a Claude account keeps (usage.accounts, its
setup-token under usage.keychainService) comes before the stored login: usage.json holds the first one's probe reading, since the
dispatcher's sessions run on it, and the stored login's only when none of them reads. With neither a stored login nor an added account, the job beats "waiting", not an error.
usage.json's `rotation` is login-flip.json's: `pool`, each account login-flip.py switches between (its TARGETS), whether its plan ends, when, and the day of the month a renewing one renews.
usage.json keeps the shape the dashboard reads (rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}, writtenAt), plus account
and source. No model call but that probe. One instance (flock).
Each cycle also runs packages/scripts/src/statusline-cost/cli.ts, which writes the status line's two retail $ figures, so the status line's own
ccusage refresh never fires; a failed or timed-out run leaves the last figures as they are and shows in the beat's detail.
"""
import datetime, fcntl, json, os, shutil, subprocess, sys, time, urllib.request

HERE = os.path.join((os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path")), "ops", "usage")  # the state folder by name, so a run by its repo path still reads the live state
OPS = os.path.dirname(HERE)
OUT = os.path.join(os.path.dirname(OPS), "usage.json")
STORED = os.path.join(HERE, "stored-login.json")
FLIP = os.path.join(HERE, "login-flip.json")
CYCLE = 300
PROBE_EVERY, FRESH_FOR = 840, 1800
API = os.environ.get("PLAYGROUND_USAGE_API") or "https://api.anthropic.com/api/oauth"  # the new-user gate points it at made-up readings in its box, so its made-up login never leaves the Mac
PROBE_URL = os.environ.get("PLAYGROUND_PROBE_URL") or "https://api.anthropic.com/v1/messages"  # the new-user gate points it at a closed loopback port, so its made-up token never leaves the Mac
STARTED = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
sys.path.insert(0, OPS)
from beat import beat, checkout, factory_login, setting  # noqa: E402

PROBE_MODEL, SERVICE = setting("models.probe"), setting("usage.keychainService")

lock = open(os.path.join(HERE, "run.lock"), "w")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit("ops-usage is already running")


def iso(t):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(t))


def write(path, data):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
    os.replace(tmp, path)


class NoLogin(RuntimeError):
    pass


def oauth():
    r = subprocess.run(["security", "find-generic-password", "-a", os.environ.get("USER", ""), "-s", "Claude Code-credentials", "-w"], capture_output=True, text=True, timeout=15)
    # 44 is security's item-not-found; a locked or denied Keychain is a failure, not a missing login
    if r.returncode == 44:
        raise NoLogin("no Claude Code credentials in the keychain")
    if r.returncode:
        raise RuntimeError(f"security exited {r.returncode} reading Claude Code's credentials")
    return json.loads(r.stdout).get("claudeAiOauth") or {}


def get(path, token):
    req = urllib.request.Request(f"{API}/{path}", headers={"Authorization": f"Bearer {token}", "anthropic-beta": "oauth-2025-04-20", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def window(w):
    if not isinstance(w, dict) or not isinstance(w.get("utilization"), (int, float)):
        return None
    resets = w.get("resets_at")
    return {"used_percentage": w["utilization"], "resets_at": int(datetime.datetime.fromisoformat(resets).timestamp()) if resets else None}


def stored_login():
    o = oauth()
    if o.get("expiresAt", 0) / 1000 < time.time():
        raise RuntimeError("access token expired; waiting for Claude Code to refresh it")
    # the account is read every cycle, with the token it goes with: the owner switches logins, and a cached email names the wrong account
    account = (get("profile", o["accessToken"]).get("account") or {}).get("email")
    u = get("usage", o["accessToken"])
    limits = {k: window(u.get(k)) for k in ("five_hour", "seven_day")}
    limits = {k: v for k, v in limits.items() if v}
    if not limits:
        raise RuntimeError("usage answered with no five_hour or seven_day window")
    return {"account": account, "rate_limits": limits, "source": "oauth/usage", "writtenAt": iso(time.time())}


def write_stored(stored):
    """The stored login's reading also lands in usage-<local part>.json beside usage.json, account-watch.py's file, which the Week tooltip reads; a failed read writes nothing, so the file keeps its last good reading."""
    account = stored.get("account")
    if account:
        write(os.path.join(os.path.dirname(OPS), f"usage-{account.split('@')[0]}.json"), stored)


def probe(email):
    """login-flip.py's probe: one 1-token call to models.probe as that account's token, whose rate-limit headers give its 5-hour and week use.
    The token goes from the Keychain into the request header and nowhere else."""
    r = subprocess.run(["security", "find-generic-password", "-s", SERVICE, "-a", email, "-w"], capture_output=True, text=True, timeout=15)
    if r.returncode:
        return None
    body = json.dumps({"model": PROBE_MODEL, "max_tokens": 1, "system": "You are Claude Code, Anthropic's official CLI for Claude.",
                       "messages": [{"role": "user", "content": "hi"}]}).encode()
    req = urllib.request.Request(PROBE_URL, data=body, headers={
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
    # a full week is limited until its reset, whatever the status header says, the same marking login-flip.py's probe sets
    if got["week"] >= 100:
        got["limitedUntil"] = got["weekReset"]
    return got


def flip_file():
    try:
        return json.load(open(FLIP))
    except (OSError, ValueError):
        return None


def seen(flip, email, now):
    """login-flip.json's reading of one account, probed again when it is PROBE_EVERY old and past its limitedUntil, so login-flip.py and this job share one probe."""
    s = (flip.get("seen") or {}).get(email) or {}
    if now - s.get("at", 0) >= PROBE_EVERY and now >= s.get("limitedUntil", 0):
        got = probe(email)
        if got:
            s = dict(got, at=now, via="token")
            flip = json.load(open(FLIP)) if os.path.exists(FLIP) else {}  # login-flip.py may have written since; keep its keys, set only this reading
            flip.setdefault("seen", {})[email] = s
            write(FLIP, flip)
    return s


def accounts_reading():
    """Each account in login-flip.json's `accounts` (every account the factory's sessions spend into) with a fresh week reading."""
    flip, now, out = flip_file() or {}, time.time(), {}
    for email in flip.get("accounts") or []:
        s = seen(flip, email, now)
        if fresh(s, now) and s.get("weekReset"):
            row = {"readAt": iso(s["at"]), "week": s["week"], "weekReset": int(s["weekReset"])}
            if s.get("limitedUntil"):
                row = {"limitedUntil": int(s["limitedUntil"]), **row}
            out[email] = row
    return out


def week_alerts(data, factory):
    """One standing alert per factory account whose week is past a mark (90, 97, 98%), naming the account and its highest mark: the logged-in account's, and each in usage.json's `accounts`. week-marks.py, which Ops' tick relays, raises each mark once."""
    weeks = {data["account"]: (data["rate_limits"].get("seven_day") or {}).get("used_percentage")}
    weeks.update({a: r.get("week") for a, r in (data.get("accounts") or {}).items() if a not in weeks})
    out = []
    for account, week in weeks.items():
        crossed = [m for m in (90, 97, 98) if isinstance(week, (int, float)) and week >= m]
        if account in factory and crossed:
            out.append({"at": data["writtenAt"], "kind": "usage", "line": f"week usage at {week:g}% ({account}), past {crossed[-1]}%", "name": account, "since": data["writtenAt"]})
    return out


def rotation(flip):
    """login-flip.json's `rotation`, {pool: [{account, ending, endsAt, renewsOn}]}, or None when it is not that shape."""
    got = flip.get("rotation")
    pool = got.get("pool") if isinstance(got, dict) else None
    entry = lambda e: isinstance(e, dict) and isinstance(e.get("account"), str) and isinstance(e.get("ending"), bool) and (e.get("endsAt") is None or isinstance(e["endsAt"], str)) and (e.get("renewsOn") is None or (type(e["renewsOn"]) is int and 1 <= e["renewsOn"] <= 31))
    return {"pool": [{"account": e["account"], "ending": e["ending"], "endsAt": e.get("endsAt"), "renewsOn": e.get("renewsOn")} for e in pool]} if isinstance(pool, list) and all(map(entry, pool)) else None


def resolved_factory(flip):
    """The factory login the pool rule (beat.factory_login) resolves for this file: the file's pool and split against its `factory`, the token read the rule's validity test."""
    pool = rotation(flip)
    return factory_login(flip.get("factory"), [e["account"] for e in pool["pool"]] if pool else None, (flip.get("split") or {}).get("shares") or {}, SERVICE)


_UNRESOLVED = object()  # factory_reading's resolved argument: absent, so the caller's None (the rule resolving to none) is taken as handed in


def factory_reading(stored, flip, accounts, resolved=_UNRESOLVED):
    """usage.json's data for the factory login resolved_factory resolves (the cycle hands one resolution in, so a cycle resolves once), when that is not the stored login and usage.accounts still lists it; else None."""
    factory = resolved_factory(flip) if resolved is _UNRESOLVED else resolved
    if not factory or (stored and factory == stored["account"]) or (accounts is not None and factory not in accounts):
        return None
    now = time.time()
    s = seen(flip, factory, now)
    if not fresh(s, now):
        raise RuntimeError(f"no reading of {factory} under {FRESH_FOR // 60} minutes old")
    return probed(factory, s, stored, now)


def fresh(s, now):
    # a full week cannot change before its weekReset, so its last reading stays fresh until then and goes stale again after
    if s.get("week") is not None and s["week"] >= 100 and s.get("weekReset"):
        return now < s["weekReset"]
    # a reading seen() holds until its limitedUntil stays fresh that long, then goes stale as before
    return (now - s.get("at", 0) < FRESH_FOR or now < s.get("limitedUntil", 0)) and s.get("week") is not None


def probed(account, s, stored, now):
    """usage.json's data from one account's probe reading, naming the stored login beside it when there is one."""
    limits = {"seven_day": {"used_percentage": s["week"], "resets_at": int(s["weekReset"]) if s.get("weekReset") else None}}
    if s.get("five") is not None:
        # a 5-hour figure past its reset says nothing about the window now, so it counts as none in use
        limits["five_hour"] = {"used_percentage": 0 if s.get("fiveReset") and now >= s["fiveReset"] else s["five"], "resets_at": int(s["fiveReset"]) if s.get("fiveReset") else None}
    data = {"account": account, "rate_limits": limits, "readAt": iso(s["at"]), "source": "token/ratelimit-headers", "writtenAt": iso(now)}
    if stored:
        data["storedLogin"] = {"account": stored["account"], "week": (stored["rate_limits"].get("seven_day") or {}).get("used_percentage")}
    return data


def added_reading(stored, flip, added):
    """usage.json's data for the first Claude account the Dashboard added (usage.accounts, its token under usage.keychainService) with a fresh reading, since the dispatcher and its sessions run on it; None when none has one."""
    now = time.time()
    for email in added:
        s = seen(flip, email, now)
        if fresh(s, now):
            return probed(email, s, stored, now)
    if added:
        raise RuntimeError(f"no reading of {', '.join(added)} under {FRESH_FOR // 60} minutes old")
    return None


def statusline_cost(cli=None, timeout=120):
    """Runs the status line's $ reader once; None when it wrote its figures, else the problem. The CLI writes each file whole by a rename, so a failure leaves the last ones."""
    cli = cli or os.path.join(checkout(), "packages", "scripts", "src", "statusline-cost", "cli.ts")
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    try:
        r = subprocess.run([bun, "--no-env-file", cli, "--state", os.path.join(OPS, "statusline-cost.json")], capture_output=True, text=True, errors="replace", timeout=timeout, cwd="/")
    except (OSError, subprocess.TimeoutExpired) as e:
        return f"statusline cost: {type(e).__name__}"
    return None if r.returncode == 0 else f"statusline cost: exit {r.returncode}: {r.stderr.strip()[-120:]}"


while True:
    problems, stored, data, no_login = [], None, None, False
    cost_problem = statusline_cost()
    # The factory's accounts, usage.accounts read each cycle so a change lands with no restart: the Dashboard's Add a Claude account writes them, and marks and alerts count these alone.
    try:
        FACTORY = [a["email"] for a in setting("usage.accounts") if a.get("provider", "claude") == "claude"]
    except SystemExit as e:
        problems.append(f"usage.accounts: {e}")
        FACTORY = None  # no list known, so no account counts as removed this cycle
    try:
        stored = stored_login()
        write(STORED, stored)
        write_stored(stored)
    except Exception as e:
        no_login = isinstance(e, NoLogin)
        problems.append(f"stored login: {type(e).__name__}: {e}")
    flip = flip_file() or {}
    resolved = resolved_factory(flip)
    try:
        data = factory_reading(stored, flip, FACTORY, resolved)
    except Exception as e:
        problems.append(f"factory account: {type(e).__name__}: {e}")
    # the factory login, resolved through the pool rule, is the account the sessions run on, so the added ones are read only while it resolves to none
    if not data and not resolved:
        try:
            data = added_reading(stored, flip, FACTORY or [])
        except Exception as e:
            problems.append(f"added account: {type(e).__name__}: {e}")
    data = data or stored
    if data:
        try:
            accounts = accounts_reading()
            if accounts:
                data["accounts"] = accounts
        except Exception as e:
            problems.append(f"accounts: {type(e).__name__}: {e}")
        pool = rotation(flip)
        if pool:
            data["rotation"] = pool
        write(OUT, data)
        account, limits = data["account"], data["rate_limits"]
        # the outbox needs a session to relay it; the marks also go to ops/alerts-usage.json, which ops-unstick folds into alerts-pending.json
        out = week_alerts(data, FACTORY or [])
        if account in (FACTORY or []):
            # dispatcher, 8 Oct: the 5-hour window at 90% or more, while it lasts, so the Builder slows spawns before the cap
            five = limits.get("five_hour") or {}
            if isinstance(five.get("used_percentage"), (int, float)) and five["used_percentage"] >= 90:
                at = time.strftime("%H:%MZ", time.gmtime(five["resets_at"])) if isinstance(five.get("resets_at"), (int, float)) else "unknown"
                out.append({"at": data["writtenAt"], "kind": "usage-5h", "line": f"5-hour window at {five['used_percentage']:g}% ({account}), resets {at}: slow spawns", "name": account, "since": data["writtenAt"]})
        write(os.path.join(OPS, "alerts-usage.json"), {"alerts": out, "writtenAt": data["writtenAt"]})
    five = data and data["rate_limits"].get("five_hour", {}).get("used_percentage")
    detail = f"{data['account']}: 5h {'none' if five is None else f'{five}%'}, 7d {data['rate_limits'].get('seven_day', {}).get('used_percentage')}%" if data else ""
    # an expired stored token is expected while every session runs on another account's token, so only a missing factory reading fails; with no account at all, the job waits for one
    if data and not any(p.startswith("factory") for p in problems):
        result = "ok"
    elif no_login and not FACTORY and len(problems) == 1:
        result = "waiting: no Claude account yet; add one in the Dashboard"
    else:
        result = ("error: " + "; ".join(problems))[:120]
    if data and problems:
        detail += " (" + "; ".join(problems)[:200] + ")"
    # the status line's figures are not usage.json's, so a failed run shows in the detail and leaves the job's result alone
    if cost_problem:
        detail += f" ({cost_problem})"
    beat("ops-usage", os.getpid(), STARTED, CYCLE, result, {"detail": detail})
    time.sleep(CYCLE)

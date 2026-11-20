#!/usr/bin/env python3
"""account-watch.py <email>: one reading of a Claude account other than this Mac's own login, written to
usage-<local part>.json in the data folder, in usage.json's shape, so the factory can move to another account near its week's end and spawn.sh
judges an --account start on it; ops-tick's other-logins beat runs it every 30 minutes for each Claude row of usage.accounts but the stored login.
It reads the account's long-lived token from the Keychain (service usage.keychainService) into one 1-token call's header, to models.probe, and
nowhere else (a setup-token has the inference scope alone, so the usage endpoint refuses it), and takes the 5-hour and week use from
the rate-limit headers, as login-flip.py's probe does. Prints one line; exits 1 when it cannot read the account."""
import datetime, json, os, subprocess, sys, urllib.request

if len(sys.argv) != 2 or "@" not in sys.argv[1]:
    sys.exit("usage: account-watch.py <email>")
email = sys.argv[1]
sys.path.insert(0, os.path.join((os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path")), "ops"))
from beat import OPS, setting  # noqa: E402

OUT = os.path.join(os.path.dirname(OPS), f"usage-{email.split('@')[0]}.json")

r = subprocess.run(["security", "find-generic-password", "-s", setting("usage.keychainService"), "-a", email, "-w"], capture_output=True, text=True, timeout=15)
if r.returncode:
    sys.exit(f"no Keychain item for {email}")
body = json.dumps({"model": setting("models.probe"), "max_tokens": 1, "system": "You are Claude Code, Anthropic's official CLI for Claude.",
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
    sys.exit(f"{email}: no rate-limit headers in the answer")
f = lambda k: float(h.get(f"anthropic-ratelimit-unified-{k}") or 0)
now = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
rate = {"seven_day": {"used_percentage": round(f("7d-utilization") * 100, 3), "resets_at": int(f("7d-reset"))}}
# an account with no 5-hour limit sends no 5h headers, so its reading omits five_hour, as usage.json's does
if h.get("anthropic-ratelimit-unified-5h-utilization") is not None:
    rate["five_hour"] = {"used_percentage": round(f("5h-utilization") * 100, 3), "resets_at": int(f("5h-reset"))}
out = {"account": email, "rate_limits": rate, "status": h.get("anthropic-ratelimit-unified-status"), "source": "token/ratelimit-headers", "writtenAt": now}
tmp = OUT + ".tmp"
json.dump(out, open(tmp, "w"))
os.replace(tmp, OUT)
rl = out["rate_limits"]
five = f"{rl['five_hour']['used_percentage']}%" if "five_hour" in rl else "none"
print(f"{email}: 5h {five} week {rl['seven_day']['used_percentage']}% ({out['status']}) -> {OUT}")

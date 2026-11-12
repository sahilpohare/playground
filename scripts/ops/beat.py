#!/usr/bin/env python3
"""beat.py <job> <pid> <startedAt> <cycleSeconds> <lastResult> [extra JSON]: write the job's heartbeat, ops/<job>.json, atomically.
Imported, it also holds checkout(), the one place the ops scripts name the main checkout, and the factory login's one rule (factory_login, with has_token beside it), which login-flip.py and run.py read the flip state's `factory` through.

The dashboard reads it: Running while lastResult is "ok" and lastBeatAt is fresh, Waiting while it starts "waiting: " (the reason after it), Failing when lastResult is anything else,
Down when lastBeatAt is older than 3 x cycleSeconds, the pid is gone or the file is missing.
"""
import json, os, shutil, subprocess, sys, time

RESOLVER = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "packages", "env", "src", "data-dir.ts")


def ops_dir():
    """The data folder's ops, as dataDir() in packages/env/src/data-dir.ts resolves it, so the TS jobs and these scripts read one folder; the same rule in Python when bun cannot answer."""
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    try:
        r = subprocess.run([bun, "--no-env-file", "-e", f"import {{ dataDir }} from {json.dumps(RESOLVER)}; console.log(dataDir())"], capture_output=True, text=True, timeout=30, cwd="/")
        if r.returncode == 0 and r.stdout.strip():
            return os.path.join(r.stdout.strip(), "ops")
    except Exception:
        pass
    # the data folder's rule without bun: each ops script that finds this file writes the same expression inline, since it has no import to share until it has found it
    return os.path.join((os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path")), "ops")


OPS = ops_dir()


def checkout():
    """The factory's main checkout: PLAYGROUND_REPO, else the main checkout of the folder the job runs in, else that of the checkout this file sits in, else playground in the code root's default (the folder that holds that checkout)."""
    if os.environ.get("PLAYGROUND_REPO"):
        return os.environ["PLAYGROUND_REPO"]
    own = os.path.dirname(os.path.dirname(os.path.dirname(os.path.realpath(__file__))))
    for folder in (None, own):
        r = subprocess.run(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], capture_output=True, text=True, cwd=folder)
        root = os.path.dirname(r.stdout.strip()) if r.returncode == 0 else folder
        if root and os.path.exists(os.path.join(root, "scripts", "spawn.sh")):
            return root
    return os.path.join(os.path.dirname(own), "playground")


def beat(job, pid, started_at, cycle_seconds, last_result, extra=None):
    path = os.path.join(OPS, f"{job}.json")
    data = {"job": job, "pid": int(pid), "startedAt": started_at, "lastBeatAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "lastResult": (last_result or "ok")[:120], "cycleSeconds": int(cycle_seconds)}
    if extra:
        data.update(json.loads(extra) if isinstance(extra, str) else extra)
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w") as f:
        json.dump(data, f)
        f.write("\n")
    os.replace(tmp, path)


def setting(key):
    """A setting's value as the settings reader in the factory's checkout prints it (packages/scripts/src/playground/setting.ts), its default on a machine with no extensions; stops naming why when the reader cannot answer."""
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    r = subprocess.run([bun, os.path.join(checkout(), "packages", "scripts", "src", "playground", "setting.ts"), key], capture_output=True, text=True, timeout=60, cwd="/")
    if r.returncode != 0:
        raise SystemExit(f"{key}: {r.stderr.strip() or f'exit {r.returncode}'}")
    return json.loads(r.stdout)


def has_token(account, service):
    """Whether the account's long-lived token still sits in the Keychain: the item's existence, judged by the exit alone, its secret never read; a read that fails or outlasts its 15 seconds counts as none."""
    try:
        return subprocess.run(["security", "find-generic-password", "-s", service, "-a", account], capture_output=True, text=True, timeout=15).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def factory_login(factory, pool, shares, service):
    """The factory login's one rule, which every reader of the flip state's `factory` reads it through: `factory` itself while the pool lists it and its token still reads, else the pool account `shares` gives the best share among those holding a token; `factory` unchanged when the pool reads none, and None when it names no factory or no candidate holds one."""
    if not factory or pool is None:
        return factory
    if factory in pool and has_token(factory, service):
        return factory
    return max((a for a in pool if a != factory and has_token(a, service) and shares.get(a, 0) > 0), key=shares.get, default=None)


if __name__ == "__main__":
    beat(*sys.argv[1:7])

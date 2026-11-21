#!/usr/bin/env python3
"""ops-up: start every ops job in jobs.json that is not healthy, and leave healthy ones alone.

A job ops starts in a terminal (one whose `runtime` names one, or that names none and has a command and no launchd label) runs as a pane of the Ops
workspace on the factory herdr server (the binary pin.json names, as spawn.sh reaches it). A `runtime`, whatever word an older
install stored, reads as herdr, the one runtime.

  up.py                      check every job once; start each unhealthy terminal job as a pane of herdr's Ops workspace
  up.py --restarted <a,b>    a plain pass, once any running pass ends, with those jobs' starts dropped first, so GRACE holds
                             back no job ops-restart stopped (packages/scripts/src/ops-restart); a start made from START_WINDOW
                             before the call on, one made while it waits on up.lock included, is kept and logged, since
                             another pass started the job after it stopped
  up.py --sessions           list, never run, the commands that bring the factory's Claude sessions back

Any other argument is refused with the usage line, exit 1, and runs no pass.

Healthy means the job's heartbeat (ops/<name>.json) is fresh (within three cycles), its pid is alive, its last result
is not an exit. An unhealthy job's old herdr pane, which ops opened, is closed first (ops-dashboard then waits until its
recorded process groups are gone, stopping them through procs.sh);
nothing is ever selected by name or pattern. A launchd job is only reported, once after DOWN_PASSES unhealthy passes in a row: launchd, or on Linux its systemd user unit, keeps it alive. A job whose holder runs an
executable an update deleted, or whose heartbeat pid does while a holder or launchd holds it, (lsof, once a pass) is unhealthy: a
terminal job is stopped by its recorded pid and started again, a launchd job is reported once. A job that fails to start is logged
with herdr's whole answer and tried again on the next pass; only one that started waits out GRACE. Every pass exits 0.
herdr closes a job's pane the moment its job exits, so a restart reads why the job stopped from ops/<job>.last, the last
stderr line once.py's reader kept, when it was written after the job's last start, and a private notify.sh line tells
ops once per job until the line changes (ops/up-last-lines.json, 0600) or the job is healthy again; the printed started
line leaves it out, since ops-tick sends every printed line to ops in public.
"""
import calendar, fcntl, glob, hashlib, json, os, re, shutil, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
CFG = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
_hook = os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), "inscope", "inscope.zsh")
try:
    _hooked = open(_hook).read()
except OSError:
    _hooked = ""
# under the inscope signal spawn.sh drops CLAUDE_CONFIG_DIR and INSCOPE_CCD and registers sessions under ~/.claude, so the sessions and transcripts read there too
REGISTRY = (
    os.path.expanduser("~/.claude")
    if os.environ.get("INSCOPE_CCD") or "INSCOPE_CCD" in _hooked or "CLAUDE_CONFIG_DIR" in _hooked
    else CFG
)
# spawn.sh's data folder, as dataDir() reads it: PLAYGROUND_DATA_DIR when set, else .playground in the home folder; it keeps the backend pins and the roster there
DATA = (os.path.abspath(os.environ.get("PLAYGROUND_DATA_DIR") or os.path.expanduser("~/.playground")) if os.path.isabs(os.environ.get("PLAYGROUND_DATA_DIR") or "/") else sys.exit(f"PLAYGROUND_DATA_DIR is relative ({os.environ['PLAYGROUND_DATA_DIR']}), so each process would read it from its own folder: set it to an absolute path"))
GRACE = 600  # a job started this recently has not had time to write its first heartbeat, so it is left alone
START_WINDOW = 10  # a start this close before a --restarted call, or after it, came from another pass after the job stopped, so that call keeps it
DOWN_PASSES = 3  # a launchd job unhealthy this many passes in a row is told to ops once, since launchd is not bringing it back
SPAWN = os.path.join(os.path.dirname(HERE), "spawn.sh")  # the one way a session comes back, through the factory's capacity gate
ONCE = os.path.join(HERE, "once.py")  # every job starts through it: one copy per job, held by its recorded pid
_spec = __import__("importlib.util").util.spec_from_file_location("once", ONCE)
once = __import__("importlib.util").util.module_from_spec(_spec)
_spec.loader.exec_module(once)
sys.path.insert(0, HERE)
import ptable

OPS = once.OPS
LOG = os.path.join(OPS, "up.log")
STARTS = os.path.join(OPS, "up-state.json")
LAST_TOLD = os.path.join(OPS, "up-last-lines.json")  # each job's last line already told to ops

HERDR_DIR = os.environ.get("PLAYGROUND_HERDR_DIR") or os.environ.get("DESK_HERDR_DIR") or os.path.expanduser("~/.playground/herdr")
HERDR_SESSION = os.environ.get("PLAYGROUND_HERDR_SESSION") or os.environ.get("DESK_HERDR_SESSION") or "playground"


def log(msg):
    with open(LOG, "a") as f:
        f.write(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}\n")


def run_streams(argv, timeout=60, env=None):
    """(exit code, stdout, stderr) of the command, its streams apart, as a caller that reads one alone needs."""
    try:
        r = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, env=env)
        return r.returncode, r.stdout or "", r.stderr or ""
    except Exception as e:
        return 1, "", str(e)


def run(argv, timeout=60, env=None):
    code, out, err = run_streams(argv, timeout, env)
    return code, out + err


def alive(pid):
    try:
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def healthy(job):
    try:
        b = json.load(open(os.path.join(OPS, f"{job['heartbeat']}.json")))
    except Exception:
        return False, "no heartbeat"
    age = time.time() - calendar.timegm(time.strptime(b["lastBeatAt"][:19], "%Y-%m-%dT%H:%M:%S"))
    if age > 3 * int(b.get("cycleSeconds", 60)):
        return False, f"heartbeat {int(age // 60)}m old"
    if not alive(b.get("pid", 0)):
        return False, "process gone"
    if "exited" in str(b.get("lastResult", "")):
        return False, str(b["lastResult"])
    return True, "ok"


def is_herdr(job):
    """Whether ops starts the job in a terminal, which is herdr: its runtime names one, whatever word an older install stored, or it names none and has a command and no launchd label (a hand-kept jobs.json row the render never parsed)."""
    return job.get("runtime") is not None or (bool(job.get("command")) and not job.get("launchd"))


def is_dashboard(job):
    return job.get("stop") == "dashboard"


# The factory-role rule from its one source: the names of the [name, the roster's kind] pairs on stdin that factoryRoleOf places in the factory; kinds.ts imports nothing, so Bun reads it from source as the hooks do
KINDS = os.path.join(os.path.dirname(os.path.dirname(HERE)), "packages", "config", "src", "kinds.ts")
# The machine's managers' names (sessions.names and sessions.aliases) are set first, so a manager's name places as the hooks place it; with none readable the role words stand.
SETTING = os.path.join(os.path.dirname(os.path.dirname(HERE)), "packages", "scripts", "src", "playground", "setting.ts")
IN_FACTORY = "const [kinds, setting] = process.argv.slice(-2); try { (await import(setting)).loadSessionNames() } catch {} const { factoryRoleOf } = await import(kinds); console.log(JSON.stringify((await Bun.stdin.json()).filter(([name, kind]) => factoryRoleOf(name, kind)).map(([name]) => name)))"


def in_factory(names):
    """The names the factory-role rule places in the factory, by the roster's kind for each name, else the name, in one Bun call; None when Bun cannot answer."""
    if not names:
        return []
    kinds = roster_kinds()
    try:
        r = subprocess.run([shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun"), "--no-env-file", "-e", IN_FACTORY, KINDS, SETTING],
                           input=json.dumps([[name, kinds.get(name)] for name in names]), capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except Exception:
        return None


def one_line_answer(out):
    """An answer whole, on one line."""
    return " ".join(line.strip() for line in out.splitlines() if line.strip()) or "no answer"


def beat_pid(job):
    try:
        return int(json.load(open(os.path.join(OPS, f"{job['heartbeat']}.json"))).get("pid") or 0)
    except Exception:
        return 0


def boot_time():
    """The machine's boot time as epoch seconds, from sysctl on macOS and /proc/stat on Linux, else 0, so a just-started job is left alone only while the machine that ran it is still up."""
    try:
        r = subprocess.run(["sysctl", "-n", "kern.boottime"], capture_output=True, text=True, timeout=5)
        if r.returncode == 0:
            m = re.search(r"\bsec = (\d+)", r.stdout)
            if m:
                return int(m.group(1))
    except Exception:
        pass
    try:
        with open("/proc/stat") as f:
            for line in f:
                if line.startswith("btime "):
                    return int(line.split()[1])
    except Exception:
        pass
    return 0


def beat_started(job):
    """The heartbeat's startedAt as epoch seconds, else 0: the moment the job recorded, so a start at or after the recorded one ends the grace and the job is restarted."""
    try:
        b = json.load(open(os.path.join(OPS, f"{job['heartbeat']}.json")))
        return calendar.timegm(time.strptime(b["startedAt"][:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception:
        return 0


def grace_ended(job, start_at):
    """Whether the start grace is over, so a job recorded within GRACE is restarted: its heartbeat recorded a start at or after the recorded one, or the machine booted at or after it, since the just-started loop went down with that boot."""
    beat = beat_started(job)
    return bool(beat and beat >= start_at) or bool(start_at and start_at <= boot_time())


def deleted(pids):
    """Each of the pids whose executable no longer exists, with that path, read in one lsof call (the first txt file after each pid); a failed or empty read finds none."""
    if not pids:
        return {}
    found, pid = {}, None
    for line in run(["lsof", "-a", "-p", ",".join(map(str, sorted(pids))), "-d", "txt", "-Fpn"], 10)[1].splitlines():
        if line[:1] == "p" and line[1:].isdigit():
            pid = int(line[1:])
        elif line[:1] == "n" and pid is not None and pid not in found:
            found[pid] = line[1:]
    return {pid: exe for pid, exe in found.items() if exe.startswith("/") and not os.path.exists(exe)}


def stale_of(holder, beat, gone):
    """Why a job runs on a deleted executable (an update removed it), its holder's or its heartbeat pid's, else ""."""
    if holder in gone:
        return f"runs a deleted executable ({gone[holder]})"
    if beat in gone:
        return f"holds pid {beat}, which runs a deleted executable ({gone[beat]})"
    return ""


def last_line(name, since):
    """The job's last stderr line, as once.py's reader kept it, when written after the job's last start (since), else ""."""
    path = os.path.join(OPS, f"{name}.last")
    try:
        if os.path.getmtime(path) < since:
            return ""
        return open(path).read().strip()[: once.LAST_MAX]
    except OSError:
        return ""


def told_last(name, line):
    """Record line as the job's last line told to ops, line None forgetting it; True when it differs from the one told before."""
    try:
        told = json.load(open(LAST_TOLD))
    except Exception:
        told = {}
    if told.get(name) == line:
        return False
    if line is None:
        told.pop(name)
    else:
        told[name] = line
    once.private(LAST_TOLD, json.dumps(told))
    return line is not None


def herdr():
    """(the pinned herdr binary, "") while it hashes to its pin's sha256, reads its version and the factory server's socket exists, else (None, why)."""
    try:
        pin = json.load(open(os.path.join(HERDR_DIR, "pin.json")))
        path = pin["path"]
        found = hashlib.sha256(open(os.path.realpath(path), "rb").read()).hexdigest()
    except Exception:
        return None, f"it cannot read the herdr pin {HERDR_DIR}/pin.json"
    if found != pin.get("sha256"):
        return None, f"herdr at {path} does not hash to its pin's sha256"
    if run([path, "--version"], 20)[1].strip().split("\n")[0] != f"herdr {pin.get('version')}":
        return None, f"herdr at {path} does not read herdr {pin.get('version')} on --version"
    if not os.path.exists(os.path.join(HERDR_DIR, f"{HERDR_SESSION}.sock")):
        return None, f"the herdr server {HERDR_SESSION} has no socket in {HERDR_DIR}"
    # a crashed server leaves its socket, so it must also say it runs, as spawn.sh checks
    try:
        r = subprocess.run([path, "status", "server", "--json"], capture_output=True, text=True, timeout=30, env=hr_env())
        running = json.loads(r.stdout).get("running") is True
    except Exception:
        running = False
    if not running:
        return None, f"the herdr server {HERDR_SESSION} is not running at its socket in {HERDR_DIR}"
    return path, ""


def hr_env():
    return {**os.environ, "HERDR_SESSION": HERDR_SESSION, "HERDR_SOCKET_PATH": os.path.join(HERDR_DIR, f"{HERDR_SESSION}.sock"), "HERDR_CONFIG_PATH": os.path.join(HERDR_DIR, "config.toml")}


def hr(binary, *args):
    """herdr on the factory server, as spawn.sh's hr(): (exit code, its JSON answer's result, what it said on stderr)."""
    try:
        r = subprocess.run([binary, *args], capture_output=True, text=True, timeout=30, env=hr_env())
    except Exception as e:
        return 1, {}, str(e)
    try:
        result = json.loads(r.stdout).get("result") or {}
    except Exception:
        result = {}
    return r.returncode, result, (r.stderr or "").strip()


def ops_panes(binary):
    """[(pane id, label)] in the herdr Ops workspace, oldest first, and that workspace's id or None."""
    ws = next((w.get("workspace_id") for w in hr(binary, "workspace", "list")[1].get("workspaces", []) if w.get("label") == GRID), None)
    if not ws:
        return [], None
    return [(p["pane_id"], p.get("label")) for p in hr(binary, "pane", "list", "--workspace", ws)[1].get("panes", []) if p.get("workspace_id") == ws], ws


def start_herdr(job, binary, command, cwd):
    panes, _ = ops_panes(binary)
    if panes:
        _, r, answer = hr(binary, "pane", "split", panes[-1][0], "--direction", "right", "--cwd", cwd, "--no-focus")
        pane = (r.get("pane") or {}).get("pane_id")
    else:
        _, r, answer = hr(binary, "workspace", "create", "--cwd", cwd, "--label", GRID, "--no-focus")
        pane = (r.get("root_pane") or {}).get("pane_id")
    if not pane:
        log(f"started {job['name']} in herdr {GRID}: herdr opened no pane{': ' + answer if answer else ''}")
        return False
    # the label carries the job's name, so in_grid finds the pane and a restart keeps it; a pane that fails a step is closed, as spawn.sh does
    for step, arg in (("rename", job["name"]), ("run", f"cd {cwd} && exec python3 -I {ONCE} {job['name']} {command}")):
        code, _, answer = hr(binary, "pane", step, pane, arg)
        if code:
            hr(binary, "pane", "close", pane)
            log(f"started {job['name']} in herdr {GRID}: pane {step} failed, so pane {pane} is closed{': ' + answer if answer else ''}")
            return False
    log(f"started {job['name']} in herdr {GRID}: ok, pane {pane}")
    return True


# the dashboard's jobs, each a pid file procs.sh reads: the follower first, then the API, a swap's next web and the web
JOBS = ("dashboard-ingest", "dashboard-dev", "dashboard-web-next", "dashboard-web")


def stop_dashboard():
    """Wait for the old dashboard stack's recorded groups to go, stopping what is left through procs.sh (never by name)."""
    procs = os.path.join(HERE, "dashboard", "procs.sh")
    for _ in range(40):
        if not any(run([procs, "left", job])[1].strip() for job in JOBS):
            return
        time.sleep(1)
    for job in JOBS:
        run([procs, "stop", job], 60)


GRID = "Ops"  # every terminal job runs as a pane of this one herdr workspace
EXT = "ext:"  # a command word ext:<scope>/<path> names an extension file, which rendered.ts resolves at each start
RENDERED = os.path.join(os.path.dirname(os.path.dirname(HERE)), "packages", "scripts", "src", "playground", "rendered.ts")


def resolved(command):
    """The command with each ext:<scope>/<path> word made the path rendered.ts prints on stdout, the extension's latest accepted revision, and the refusal when one does not resolve."""
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    words = []
    for word in command.split(" "):
        if word.startswith(EXT):
            code, out, err = run_streams([bun, "--no-env-file", RENDERED, word[len(EXT):]], 30)
            if code != 0:
                return None, one_line_answer(out + err) or f"rendered.ts exited {code} on {word}"
            word = out.strip()
        words.append(word)
    return " ".join(words), None


def marker(job):
    """The job's folder (ops/<name>/), which its loop's command line holds even after a wrapper execs."""
    argv = [os.path.expanduser(a) for a in job["command"].split()]
    ext = next((a[len(EXT):] for a in argv if a.startswith(EXT)), None)
    if ext:
        return once.marker_of(ext)
    script = next((a for a in argv if "/" in a and os.path.isfile(a) and not a.endswith(("/python3", "/bash", "/env"))), argv[0])
    return once.marker_of(script)


def in_grid(job, binary):
    """Whether the job has a pane in herdr's Ops workspace."""
    return bool(binary) and any(label == job["name"] for _, label in ops_panes(binary)[0])


def start(job):
    """Start the job as a pane of herdr's Ops workspace, closing its old pane there first (best effort); True once it started."""
    command, refused = resolved(job["command"])
    if refused:
        log(f"started {job['name']}: not started, since {refused}")
        return False
    command = command.replace("~/", os.path.expanduser("~") + "/")
    binary = herdr()[0]
    for pane, label in ops_panes(binary)[0] if binary else []:
        if label == job["name"]:
            hr(binary, "pane", "close", pane)
    if is_dashboard(job):
        stop_dashboard()
    return start_herdr(job, binary, command, os.path.expanduser(job["cwd"]))


JOBS_RENDER = os.path.join(os.path.dirname(os.path.dirname(HERE)), "packages", "scripts", "src", "playground", "jobs.ts")


def kept_by(job):
    """What keeps a launchd job alive, as a report names it: launchd's label on macOS, and on Linux the systemd user unit of the same name."""
    if sys.platform.startswith("linux"):
        return f"systemd unit {job.get('launchd')}.service"
    return f"launchd job {job.get('launchd')}"


def render_jobs():
    """jobs.json from the store's job settings and each org's own job rows, each org's script folders under ops, and each enabled launchd job's plist into ops/launch-agents, a turned-off job's plist going to the trash; a launchd job of Playground's own turned on and not loaded is installed in ~/Library/LaunchAgents when its plist is missing there and bootstrapped, and one turned off has its plist there trashed and is booted out while loaded, or on Linux the same as a systemd user unit in ~/.config/systemd/user, enabled, or disabled, trashed and stopped, linger turned on before its first start (exit 1 logs the one the trash kept, each refused bootstrap, bootout, enable, disable or stop and each org job row refused, and exit 0 or 1 logs linger turned on or refused); a machine with no store keeps its own jobs.json, and one whose store read is refused keeps the last and logs why."""
    bun = shutil.which("bun") or os.path.expanduser("~/.bun/bin/bun")
    if not (os.path.exists(bun) and os.path.exists(JOBS_RENDER)):
        return
    try:
        r = subprocess.run([bun, "--no-env-file", JOBS_RENDER, "render", "--data", os.path.dirname(OPS), "--jobs", os.path.join(OPS, "jobs.json"), "--launch-agents", os.path.join(OPS, "launch-agents"), "--install", os.path.expanduser("~/.config/systemd/user" if sys.platform.startswith("linux") else "~/Library/LaunchAgents")],
                           capture_output=True, text=True, timeout=60)
    except Exception as e:
        log(f"jobs.json kept: {e}")
        return
    if r.returncode in (0, 1) and r.stdout.strip() and "unchanged" not in r.stdout:
        log(r.stdout.strip())
    named = [line for line in (r.stderr or "").splitlines() if line.startswith(("jobs: kept ", "jobs: refused ", "jobs: turned on "))]
    if r.returncode in (0, 1) and named:
        log(" ".join(named))
    elif r.returncode not in (0, 3):
        log(f"jobs.json kept: {one_line_answer(r.stderr or r.stdout)}")


def up(quiet):
    render_jobs()
    jobs = json.load(open(os.path.join(OPS, "jobs.json")))["jobs"]
    try:
        starts = json.load(open(STARTS))
    except Exception:
        starts = {}
    skip = os.environ.get("OPS_UP_SKIP", "")
    procs = ptable.table()
    holders = {job["name"]: once.running(job["name"], marker(job)) if job.get("command") else None for job in jobs}
    beats = {job["name"]: beat_pid(job) for job in jobs if job.get("heartbeat")}
    gone = deleted({pid for pid in [*holders.values(), *beats.values()] if pid})
    for job in jobs:
        holder = holders[job["name"]]
        if job.get("disabled"):
            starts.get("_down", {}).pop(job["name"], None)
            # a paused job stops itself here: ops-up started it through once.py, so its recorded pid is ours to signal
            if holder and not is_dashboard(job):
                os.kill(holder, 15)
                log(f"{job['name']} is paused; stopped its loop, pid {holder}")
            continue
        start_at = starts.get(job["name"]) or 0
        # a job started this recently is left alone, but its grace ends when it recorded a later start or the machine booted after it, so a dead job restarts on the first pass after a reboot
        if job["name"] == skip or (time.time() - start_at < GRACE and not grace_ended(job, start_at)):
            continue
        ok, why = healthy(job)
        # a heartbeat pid counts only with a holder to stop, or for a job ops-up never starts; with neither, a start would run a second copy beside it
        stale = stale_of(holder, beats.get(job["name"]) if holder or not job.get("command") else None, gone)
        if ok and stale:
            ok, why = False, stale
        if ok:
            starts.get("_down", {}).pop(job["name"], None)
            # a healthy job's told line is forgotten, so a later stop on the same line is told again
            if os.path.exists(LAST_TOLD):
                told_last(job["name"], None)
            continue
        binary = None
        if is_herdr(job):
            # checked before any stop, so a job moving to a herdr that cannot take it keeps its old copy
            binary, refused = herdr()
            if not binary:
                log(f"{job['name']} unhealthy ({why}); not starting it in herdr: {refused}")
                if not quiet:
                    print(f"{job['name']} is down, and herdr cannot start it: {refused}")
                continue
        # a holder on a deleted executable stops; a pid the snapshot lacks started after it was read (a restart during this pass), so it is left to the next pass
        moved = stale if holder and holder in procs else ""
        if moved:
            # on a deleted executable: ops-up started it through once.py, so its recorded pid is ours to signal; its trap stops its children
            os.kill(holder, 15)
            for _ in range(60):
                if not alive(holder):
                    break
                time.sleep(1)
            if alive(holder):
                log(f"{job['name']} pid {holder} {moved} and outlived its TERM by 60s; the next pass tries again")
                continue
            log(f"{job['name']} pid {holder} {moved}; stopped it")
        elif holder and not in_grid(job, binary):
            # a live copy with no pane in Ops (an orphan): starting another would stack a second supervisor, so report it
            key = f"{job['name']}:{holder}"
            if key not in starts.get("_reported", []):
                starts.setdefault("_reported", []).append(key)
                run([os.path.join(HERE, "notify.sh"), "up", f"{job['name']} is {why} but its loop, pid {holder}, is still alive; not starting a second copy"], 60)
            log(f"{job['name']} unhealthy ({why}) but pid {holder} still holds it; not starting another")
            continue
        if not is_herdr(job):
            if stale:
                # launchd (systemd on Linux) keeps it alive and ops-up never started it, so it is reported, never signalled
                key = f"{job['name']}:{beats.get(job['name'])}:deleted"
                if key not in starts.get("_reported", []):
                    starts.setdefault("_reported", []).append(key)
                    run([os.path.join(HERE, "notify.sh"), "up", f"{job['name']} pid {beats.get(job['name'])} runs a deleted executable ({gone[beats.get(job['name'])]}); {kept_by(job)} keeps it alive, so restart it there"], 60)
            log(f"{job['name']} unhealthy ({why}); {kept_by(job)} keeps it alive")
            # told once at DOWN_PASSES in a row; a healthy pass drops the count, so a later outage is told again
            down = starts.setdefault("_down", {})
            down[job["name"]] = down.get(job["name"], 0) + 1
            if down[job["name"]] == DOWN_PASSES:
                told = re.sub(r"\d+m old", "stale", why)
                run([os.path.join(HERE, "notify.sh"), "up", f"{job['name']} has been unhealthy ({told}) for {DOWN_PASSES} passes in a row; {kept_by(job)} is not bringing it back, so check it is installed and loaded (playground doctor)"], 60)
            continue
        log(f"{job['name']} unhealthy ({why}); starting")
        # the printed line is told to ops once until it changes, so a heartbeat's age stays out of it
        told = re.sub(r"\d+m old", "stale", why)
        # read before the start, whose once.py drops the line: herdr closed the dead job's pane, so this file holds why it stopped
        last = last_line(job["name"], start_at)
        # a job's error can carry a key's name or a token's piece, so the line goes to ops in private alone: ops-tick sends every printed line in public
        if last and told_last(job["name"], last):
            run([os.path.join(HERE, "notify.sh"), "up", f"{job['name']} stopped, and ops-up started it again; its last line: {last}"], 60, {**os.environ, "NOTIFY_PRIVATE": "1"})
        # only a job that started waits out GRACE; a failed start is tried again on the next pass; stamped before the start, so a line the new copy writes at once is never read as older than it
        at = time.time()
        if start(job):
            starts[job["name"]] = at
            with open(STARTS, "w") as f:
                json.dump(starts, f)
            if not quiet:
                print(f"started {job['name']} in herdr ({told})")
        elif not quiet:
            print(f"could not start {job['name']} in herdr ({told}); see {LOG}")
    with open(STARTS, "w") as f:
        json.dump(starts, f)


def roster_kinds():
    """Each roster name's kind; empty when the roster does not read."""
    try:
        agents = json.load(open(os.path.join(DATA, "roster.json"))).get("agents") or []
        return {a["name"]: a["kind"] for a in agents if isinstance(a, dict) and isinstance(a.get("name"), str) and isinstance(a.get("kind"), str)}
    except Exception:
        return {}


def command_of(pid):
    return run(["ps", "-o", "command=", "-p", str(pid)], 20)[1].strip()


def guarded(command):
    """Whether a claude command line loads the factory's hooks: a --settings file that names no-playground-leak."""
    words = command.split()
    for i, w in enumerate(words):
        path = words[i + 1] if w == "--settings" and i + 1 < len(words) else w[len("--settings="):] if w.startswith("--settings=") else ""
        try:
            if path and "no-playground-leak" in open(os.path.expanduser(path)).read():
                return True
        except OSError:
            pass
    return False


def covered(cwd):
    """Whether the project settings a session in cwd loads carry the factory's hooks: Claude Code reads .claude/settings.json in the session's own folder, not its checkout's root (measured with claude -p)."""
    try:
        return "no-playground-leak" in open(os.path.join(cwd or "/", ".claude", "settings.json")).read()
    except OSError:
        return False


def unguarded(command_of=command_of):
    """[(name, pid, cwd)] for each live factory session whose --settings and project settings both lack the factory's hooks: one a terminal restored in a folder whose project settings do not carry them."""
    rows = []
    for f in sorted(glob.glob(os.path.join(REGISTRY, "sessions", "*.json"))):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        name, pid, cwd = d.get("name") or "", d.get("pid", 0), d.get("cwd") or ""
        if alive(pid) and not covered(cwd):
            rows.append((name, pid, cwd))
    factory = in_factory([name for name, _, _ in rows])
    if factory is None:
        print("up: the factory rule in kinds.ts did not read through Bun, so no session is checked for the factory's hooks", file=sys.stderr)
        return []
    found = []
    for name, pid, cwd in rows:
        if name not in factory:
            continue
        command = command_of(pid)
        # a crashed session's file can name a pid macOS has since given to another process
        if re.match(r"(?:\S*/)?claude(?:\s|$)", command) and not guarded(command):
            found.append((name, pid, cwd))
    return found


def sessions():
    """Print, for each live-roster session, the command that brings it back with a handoff line, then each factory session to respawn for lack of its hooks."""
    roster = json.load(open(os.path.join(DATA, "roster.json")))
    running = set()
    for f in glob.glob(os.path.join(REGISTRY, "sessions", "*.json")):
        try:
            d = json.load(open(f))
        except Exception:
            continue
        if d.get("name") and alive(d.get("pid", 0)):
            running.add(d["name"])
    ids = {}
    for f in glob.glob(os.path.join(REGISTRY, "projects", "*", "*.jsonl")):
        try:
            with open(f, "rb") as fh:
                fh.seek(max(0, os.path.getsize(f) - 200_000))
                tail = fh.read().decode("utf-8", "ignore")
        except Exception:
            continue
        names = re.findall(r'"agentName":"([^"]+)"', tail)
        cwds = re.findall(r'"cwd":"([^"]+)"', tail)
        models = re.findall(r'"model":"((?:claude|glm)-[^"]*)"', tail)
        if names and cwds:
            prev = ids.get(names[-1])
            if not prev or os.path.getmtime(f) > prev[1]:
                glm = bool(models) and models[-1].startswith("glm-")
                ids[names[-1]] = (os.path.basename(f)[:-6], os.path.getmtime(f), cwds[-1], glm)
    for a in roster.get("agents", []):
        n = a.get("name")
        if a.get("status") in ("done", "ended", "paused") or n in running or n not in ids:
            continue
        sid, _, cwd, glm = ids[n]
        # a resume takes --backend only while no pin stands: with one, the pin decides and a flag is refused
        backend = "" if os.path.isfile(os.path.join(DATA, "backends", n)) else (" --backend glm" if glm else " --backend claude")
        # a session comes back in its repo's main worktree, the checkout Claude Code starts sessions in: a worktree session skips the worktree the trust dialog stops a session in, and a worker started --in another folder stays in that repository; --resume finds the session from any folder (measured), and a cwd of no checkout falls back to itself, named below
        code, common = run(["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"])
        main = os.path.dirname(common.strip()) if code == 0 and common.strip() else ""
        # a reviewer's or tester's start is refused without --pr, so its line carries its row's PRs, pr first, as spawn.sh restore passes them
        prs = [p for p in [a.get("pr")] + list(a.get("prs") or []) if isinstance(p, str) and p] if a.get("kind") in ("reviewer", "tester") else []
        pr = f" --pr {','.join(dict.fromkeys(prs))}" if prs else ""
        print(f"{SPAWN} resume {n} {main or cwd} {sid}{backend}{pr}")
        if not main:
            print(f"  ({cwd} is no git checkout; it resumes there as it is)")
        print(f'  then SendMessage {n}: "your terminal restarted; you were resumed from your transcript. Re-read your roster task and continue."')
    for name, pid, cwd in unguarded():
        print(f"{name} (pid {pid}, {cwd}) runs without the factory's hooks: respawn it from its handoff through {SPAWN} (playbook SESSIONS.md)")


def main():
    args = sys.argv[1:]
    if args == ["--sessions"]:
        sessions()
        return
    # read before the lock's wait: a start after this, or just before it, came from another pass after the job stopped
    asked = time.time()
    restarted = args[1].split(",") if len(args) == 2 and args[0] == "--restarted" else []
    if args and not restarted:
        print("usage: up.py [--restarted <a,b> | --sessions]", file=sys.stderr)
        sys.exit(1)
    os.makedirs(OPS, exist_ok=True)
    lock = open(os.path.join(OPS, "up.lock"), "w")
    try:
        # a restart waits for a running pass, whose own write of STARTS would put back the starts it drops
        fcntl.flock(lock, fcntl.LOCK_EX | (0 if restarted else fcntl.LOCK_NB))
    except OSError:
        return
    if restarted:
        try:
            starts = json.load(open(STARTS))
        except Exception:
            starts = {}
        for name in restarted:
            # an accept restarts each of its jobs by its own --restarted call, and the first call's pass starts them all
            if starts.get(name, 0) >= asked - START_WINDOW:
                log(f"another pass started {name} within {START_WINDOW}s of this restart's call; not starting it again")
                continue
            starts.pop(name, None)
        with open(STARTS, "w") as f:
            json.dump(starts, f)
    up(False)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""once.py <job> <command...>: start an ops job only when no copy of it is running, then become it (exec, so the pid stays).

A copy is running when the pid in ops/<job>.pid, or the pid in its heartbeat ops/<job>.json, is alive and its command line
still holds this job's folder (ops/<name>/, which survives a wrapper's exec and a copy run from another checkout). A held
copy prints "already running" and exits 0, so ops-up never stacks a second supervisor on a live one (two ops-fixture loops
kept a stack up after their panes closed). The check and the pid write run under a flock, so two starts at once cannot
both pass. Signals nothing: it only reads pids and execs.

Before the exec, the job's stderr goes to ops/<job>.stderr, a plain file, so a write never blocks the job or kills it with
SIGPIPE, and a forked reader (its pid in ops/<job>.reader) copies that file to the pane and keeps the last non-empty line, cut
to LAST_MAX characters, in ops/<job>.last (0600): herdr closes a job's pane the moment the job exits, so ops-up reads why a
job died there. A start drops the last copy's line first, and the reader ends once the job has; it ignores the pane's
hangup, and writes the line only while ops/<job>.reader names it.
"""
import fcntl, json, os, shlex, signal, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from beat import ops_dir

OPS = ops_dir()
LAST_MAX = 200  # characters of a job's last stderr line kept for ops-up, as ops-channel-watch cuts its own
LOG_MAX = 1 << 20  # bytes of a job's stderr file before the reader empties it, so a long run never fills the disk


def command_of(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return None
    except PermissionError:
        pass
    return subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True).stdout.strip() or None


def marker_of(script):
    # the folder's last two names (ops/<name>/), so a copy of the job run from another checkout, as ops-dashboard's exec runs, still reads as this job
    folder = os.path.dirname(script)
    return "/" + "/".join(folder.split("/")[-2:]) + "/" if folder.count("/") >= 2 else folder + "/"


def running(job, marker):
    pids = []
    try:
        pids.append(int(open(os.path.join(OPS, f"{job}.pid")).read().strip()))
    except (OSError, ValueError):
        pass
    try:
        pids.append(int(json.load(open(os.path.join(OPS, f"{job}.json")))["pid"]))
    except (OSError, ValueError, KeyError, TypeError):
        pass
    for pid in pids:
        if pid > 1 and pid != os.getpid():
            cmd = command_of(pid)
            if cmd and marker in cmd:
                return pid
    return None


def private(path, text):
    """Write text to path whole, mode 0600, by a rename, so a reader never sees half a line."""
    fd = os.open(path + ".tmp", os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)
    os.replace(path + ".tmp", path)


def read_stderr(log, last, pane, job_pid, reader=None, poll=0.2):
    """Copy the job's stderr file onto the pane as it grows and keep its last non-empty line in last while the reader file names this process, until the job has exited (this reader then has another parent) and the file is read to its end."""
    offset, rest, kept = 0, b"", None
    with open(log, "rb") as f:
        while True:
            ended = os.getppid() != job_pid
            if os.fstat(f.fileno()).st_size < offset:
                offset = 0
            f.seek(offset)
            chunk = f.read()
            offset += len(chunk)
            if chunk:
                try:
                    os.write(pane, chunk)
                except OSError:
                    pass
            *lines, rest = (rest + chunk).split(b"\n")
            rest = rest[-4 * LAST_MAX :]
            if ended and rest:
                lines, rest = lines + [rest], b""
            said = next((l.decode(errors="replace").strip() for l in reversed(lines) if l.strip()), None)
            if said is not None and said[:LAST_MAX] != kept and ours(reader):
                kept = said[:LAST_MAX]
                private(last, kept)
            if offset > LOG_MAX:
                os.truncate(log, 0)
                offset = 0
            if ended and not chunk:
                return
            __import__("time").sleep(poll)


def ours(reader):
    """True while the reader file names this process, so an old copy's reader, still draining after a new copy has started, writes no line over the new copy's."""
    try:
        return reader is None or open(reader).read().strip() == str(os.getpid())
    except OSError:
        return False


def keep_last_line(job):
    """Send this process's stderr, the job's once it execs, to its file, and fork the reader that keeps its last line."""
    log, last, mine = (os.path.join(OPS, f"{job}.{end}") for end in ("stderr", "last", "reader"))
    # this copy holds the reader file before it drops the last line, so the old copy's reader writes nothing after the drop
    private(mine, "")
    try:
        os.remove(last)
    except FileNotFoundError:
        pass
    fd = os.open(log, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_APPEND, 0o600)
    os.fchmod(fd, 0o600)
    pane, job_pid = os.dup(2), os.getpid()
    reader = os.fork()
    if reader == 0:
        os.close(fd)
        # in a herdr pane the job leads its pty's session, so its exit hangs up the reader too, before it reads the dying line
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        try:
            private(mine, f"{os.getpid()}\n")
            read_stderr(log, last, pane, job_pid, mine)
        finally:
            os._exit(0)
    os.close(pane)
    os.dup2(fd, 2)
    os.close(fd)


def main():
    if len(sys.argv) < 3:
        sys.exit("usage: once.py <job> <command...>")
    job = sys.argv[1]
    argv = [os.path.expanduser(a) for a in (shlex.split(sys.argv[2]) if len(sys.argv) == 3 else sys.argv[2:])]
    script = next((a for a in argv if "/" in a and os.path.isfile(a) and not a.endswith(("/python3", "/bash", "/env"))), argv[0])
    marker = marker_of(script)
    with open(os.path.join(OPS, f"{job}.start.lock"), "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        holder = running(job, marker)
        for _ in range(15):
            # ops-up closes an unhealthy copy's pane just before this start: give that copy a moment to exit
            if not holder:
                break
            __import__("time").sleep(1)
            holder = running(job, marker)
        if holder:
            print(f"{job} already running (pid {holder}); not starting another")
            return
        with open(os.path.join(OPS, f"{job}.pid"), "w") as f:
            f.write(f"{os.getpid()}\n")
    keep_last_line(job)
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()

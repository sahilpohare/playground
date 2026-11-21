#!/usr/bin/env python3
"""The repo starts every Postgres and Redis container on loopback only.

`bunx pglaunch -k` publishes its port on every interface (0.0.0.0), so the database is
reachable from the network, and an agent copies whatever command the repo gives it. So in
every text file the repo holds:

- nothing runs pglaunch, which has no loopback flag; first run's database step starts its
  container with docker run on 127.0.0.1 too.
- every `docker run` or `docker create` that publishes Postgres's 5432 or Redis's 6379
  binds it to 127.0.0.1, and none publishes a Postgres or Redis image's every port with -P.
- every short-syntax compose `ports:` entry for 5432 or 6379 binds 127.0.0.1 (flow lists and
  the long `published:`/`host_ip:` syntax are not read).

A command is read one line at a time, a trailing backslash joining the next, so code that
builds docker's argv as an array across lines is not parsed here. CHANGELOG.md is skipped:
it records commit subjects, which may name pglaunch.

Run: python3 tests/test_loopback_postgres.py
"""
import os
import re
import shlex
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SELF = os.path.relpath(os.path.abspath(__file__), ROOT)
SKIP = {"CHANGELOG.md"}
LOOPBACK = re.compile(r"(?:127\.0\.0\.1|\[::1\]):")
PGLAUNCH = re.compile(
    r"\b(?:bunx|bun x|npx|pnpx|pnpm dlx|pnpm exec|npm exec|yarn dlx)(?:\s+-\S+)*\s+pglaunch\b"
    r"|(?:^|[\s`$(;&|])pglaunch(?:\s+-|\s*$)"
)
DATABASE_IMAGE = re.compile(r"postgres|pgvector|postgis|redis|valkey")
# Postgres's and Redis's container ports
PORTS = {"5432", "6379"}
DOCKER = re.compile(r"\bdocker\s")
# docker's own options that take a value, before the subcommand
GLOBAL_VALUED = {"-c", "--context", "-H", "--host", "--config", "-l", "--log-level"}
# run/create's short options that take a value; the other letters in a bundle (-dit) take none
SHORT_VALUED = set("acehlmpuvw")
# run/create's long options that take no value; any other takes the next token unless it carries =
LONG_BOOLEAN = {"--detach", "--rm", "--interactive", "--tty", "--init", "--privileged", "--publish-all",
                "--read-only", "--quiet", "--no-healthcheck", "--oom-kill-disable"}


def commands(text):
    """Each line with its number, a command continued by a trailing backslash joined into its first line."""
    joined, start = "", 0
    for n, line in enumerate(text.splitlines(), 1):
        if not joined:
            start = n
        if line.endswith("\\"):
            joined += line[:-1] + " "
            continue
        yield start, joined + line
        joined = ""
    if joined:
        yield start, joined


def container_port(mapping):
    return mapping.split("/")[0].rsplit(":", 1)[-1]


def run_options(tokens):
    """The publishes, -P and image of one `docker run`'s arguments, the subcommand already read."""
    publishes, publish_all, image = [], False, ""
    while tokens:
        token = tokens.pop(0)
        if not token.startswith("-"):
            image = token
            break
        if token.startswith("--"):
            name, _, value = token.partition("=")
            if name == "--publish-all":
                publish_all = True
            elif not value and name not in LONG_BOOLEAN and tokens and not tokens[0].startswith("-"):
                value = tokens.pop(0)
            if name == "--publish" and value:
                publishes.append(value)
            continue
        for i, letter in enumerate(token[1:], 2):
            if letter == "P":
                publish_all = True
            elif letter in SHORT_VALUED:
                value = token[i:].lstrip("=") or (tokens.pop(0) if tokens else "")
                if letter == "p":
                    publishes.append(value)
                break
    return publishes, publish_all, image


def docker_publishes(line):
    """Each off-loopback publish a `docker run` or `docker create` on this line makes, as text."""
    found = []
    for match in DOCKER.finditer(line):
        segment = re.split(r"`|\s\||;|&&|\s#", line[match.start():])[0]
        try:
            tokens = shlex.split(segment)[1:]
        except ValueError:
            tokens = segment.split()[1:]
        while tokens and tokens[0].startswith("-"):
            if tokens.pop(0) in GLOBAL_VALUED and tokens:
                tokens.pop(0)
        if tokens[:1] == ["container"]:
            tokens.pop(0)
        if tokens[:1] not in (["run"], ["create"]):
            continue
        publishes, publish_all, image = run_options(tokens[1:])
        found += [f"publishes {container_port(value)} as {value}" for value in publishes
                  if container_port(value) in PORTS and not LOOPBACK.match(value)]
        if publish_all and DATABASE_IMAGE.search(image):
            found.append(f"publishes every port of {image} with -P")
    return found


def compose_publishes(text):
    """Each off-loopback 5432 or 6379 mapping under a compose `ports:` key, with its line number."""
    found, ports_indent = [], None
    for n, line in enumerate(text.splitlines(), 1):
        indent = len(line) - len(line.lstrip())
        key = re.match(r"\s*([\w-]+):", line)
        if key and not line.lstrip().startswith("-"):
            ports_indent = indent if key.group(1) == "ports" else None
            continue
        item = re.match(r"\s*-\s*['\"]?([^\s'\"#]+)['\"]?\s*(?:#.*)?$", line)
        if ports_indent is not None and item and indent >= ports_indent:
            mapping = item.group(1)
            if container_port(mapping) in PORTS and not LOOPBACK.match(mapping):
                found.append((n, mapping))
    return found


def problems_in(rel, text):
    found = []
    for n, line in commands(text):
        if PGLAUNCH.search(line):
            found.append(f"{rel}:{n}: runs pglaunch, which publishes on 0.0.0.0 and has no loopback flag yet; "
                         "use docker run -p 127.0.0.1::5432")
        for publish in docker_publishes(line):
            found.append(f"{rel}:{n}: docker {publish}, beyond loopback; use -p 127.0.0.1::<port>")
    if re.search(r"(^|/)(docker-)?compose[^/]*\.ya?ml$", rel):
        found += [f"{rel}:{n}: compose publishes {container_port(mapping)} as {mapping}, beyond loopback; "
                  f"use 127.0.0.1:<port>:{container_port(mapping)}"
                  for n, mapping in compose_publishes(text)]
    return found


def self_test():
    """The patterns flag what they must and pass what they must, so a quiet scan means something."""
    bad = [
        ("doc.md", "bunx pglaunch -k"),
        ("doc.md", "Generate using `bunx pglaunch -k`"),
        ("doc.md", "a container (`bunx pglaunch -k`; pglaunch publishes on every interface until its 127.0.0.1 default ships)"),
        ("doc.md", "Run `bunx pglaunch -k` and put the URL (postgres://postgres:pw@127.0.0.1:5432/postgres) in .env"),
        ("doc.md", "`bunx pglaunch -k` or `docker run -d -p 127.0.0.1::5432 postgres:alpine`"),
        ("doc.md", "npx pglaunch"),
        ("doc.md", "`npx -y pglaunch`"),
        ("doc.md", "`bunx --bun pglaunch`"),
        ("doc.md", "pglaunch -n my-db -k"),
        ("doc.md", "bunx --bun pglaunch@5.5.7 -k -n playground-db"),
        ("api/hono/src/lib/setup/container.ts", "// `bunx pglaunch -k -n <name>`"),
        ("api/hono/src/lib/setup/container.ts", "// `bunx --bun pglaunch@5.5.8 -k -n <name>`"),
        ("api/hono/src/lib/setup/container.ts", "// `bunx --bun pglaunch@5.5.7 -k`, then `npx pglaunch -k`"),
        ("api/hono/src/lib/setup/container.ts", "bunx --bun pglaunch@5.5.7 -k -n playground-db"),
        ("doc.md", "docker run -d -e POSTGRES_PASSWORD=pw -p 5432:5432 postgres:alpine"),
        ("doc.md", "docker run -d -p 5432 postgres:alpine"),
        ("doc.md", "docker run -d --publish=0.0.0.0:5433:5432/tcp postgres"),
        ("doc.md", "docker run -d --publish [::]:5433:5432 postgres"),
        ("doc.md", "docker run -d -p5432:5432 postgres:alpine"),
        ("doc.md", "docker run -dp 5432:5432 postgres"),
        ("doc.md", "docker run -itp 5432:5432 postgres"),
        ("doc.md", "docker run -dP postgres:alpine"),
        ("doc.md", "docker run -d -P postgres:alpine"),
        ("doc.md", "docker run -d -P pgvector/pgvector:pg17"),
        ("doc.md", "docker run --no-such-flag -p 5432:5432 postgres"),
        ("doc.md", "docker --context colima run -d -p 5432:5432 postgres"),
        ("doc.md", "docker container create -p 5432:5432 postgres"),
        ("doc.md", "docker run -d \\\n  -p 5432:5432 postgres:alpine"),
        ("docker-compose.yml", 'services:\n  db:\n    ports:\n      - "5432:5432"'),
        ("doc.md", "docker run -d --name playground-a-redis -p 6379:6379 redis:alpine"),
        ("doc.md", "docker run -d -p 6379 redis:alpine"),
        ("doc.md", "docker run -dP redis:alpine"),
        ("doc.md", "docker run -d -P valkey/valkey:8"),
        ("docker-compose.yml", 'services:\n  redis:\n    ports:\n      - "6379:6379"'),
    ]
    good = [
        ("doc.md", "docker run -d --name db -e POSTGRES_PASSWORD=pw -p 127.0.0.1::5432 postgres:alpine"),
        ("doc.md", "docker run -d -p 127.0.0.1:5433:5432 postgres:alpine"),
        ("doc.md", "docker run -d --publish [::1]:5433:5432 postgres:alpine"),
        ("doc.md", "docker run -dp 127.0.0.1:5433:5432 postgres:alpine"),
        ("doc.md", "docker run -d -p 3000:3000 web"),
        ("doc.md", "docker run --rm postgres:alpine pg_isready -h host.docker.internal -p 5432"),
        ("doc.md", "docker run -d -e PGPORT=5432 -p 127.0.0.1::5432 postgres"),
        ("doc.md", "psql -h localhost -p 5432"),
        ("doc.md", "docker port playground-a-db 5432    # 127.0.0.1:<port>"),
        ("doc.md", "- **db:** Start local postgres on loopback only, and fail on pglaunch or a wide publish (#48)"),
        ("doc.md", "`pglaunch` publishes on every interface; it can come back once its loopback default ships"),
        ("docker-compose.yml", 'services:\n  db:\n    ports:\n      - "127.0.0.1:5432:5432"'),
        ("docker-compose.yml", 'services:\n  api:\n    ports:\n      - "127.0.0.1:4000:4000"'),
        ("docker-compose.yml", 'services:\n  db:\n    expose:\n      - "5432"'),
        ("doc.md", "docker run -d --name playground-a-redis -p 127.0.0.1::6379 redis:alpine"),
        ("docker-compose.yml", 'services:\n  redis:\n    ports:\n      - "127.0.0.1:6379:6379"'),
    ]
    wrong = [f"not flagged: {line!r}" for rel, line in bad if not problems_in(rel, line)]
    wrong += [f"flagged: {line!r}" for rel, line in good if problems_in(rel, line)]
    return wrong


def main():
    wrong = self_test()
    for line in wrong:
        print(f"FAIL self-test {line}")
    files = subprocess.run(["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                           cwd=ROOT, capture_output=True, text=True, check=True).stdout.splitlines()
    checked = 0
    failures = []
    for rel in files:
        path = os.path.join(ROOT, rel)
        if rel in SKIP or rel == SELF or os.path.islink(path) or not os.path.isfile(path):
            continue
        try:
            text = open(path, encoding="utf-8").read()
        except UnicodeDecodeError:
            continue
        checked += 1
        failures += problems_in(rel, text)
    for failure in failures:
        print(f"FAIL {failure}")
    total = len(wrong) + len(failures) + (0 if checked else 1)
    print(f"{'PASS' if not total else 'FAIL'} {checked} files checked, {len(failures)} off-loopback Postgres or Redis commands")
    print("FAILURES:", total)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main())

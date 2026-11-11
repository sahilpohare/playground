#!/usr/bin/env python3
"""Checks every skill's frontmatter for the properties the repo relies on.

- Each skill's `name` matches its folder, and it has a description.
- `disallowed-tools` appears only together with `context: fork` and
  `background: false`: on the main thread the block lasts for the rest of the
  turn and would strand the skill that called it (ADR 0002).
- setup is user-invoked only, since it installs software.
- Every skill ends with the clause that sends what it learns to the dispatcher session, but a
  copy of an upstream skill (COPIED), which a drift test holds to upstream's text.
- A skill with disallowed-tools never tells its run to use a tool that list blocks, nor a
  compound command with a part it blocks (the whole command is refused): a headless run would
  spend a turn on the denial. The check runs on planted sentences against a read-only
  blocklist, so it stays proven with no such skill in this tree.

Run: python3 tests/test_skill_frontmatter.py
"""
import fnmatch
import glob
import json
import os
import re
import shlex
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Skills copied whole from upstream, held to its text by tests/extensions/core/skills/<name>/drift.test.ts.
COPIED = {"pr"}

# Core's upstream skills, held byte for byte to each extensions/core/upstream/<name>/MANIFEST, so their frontmatter is upstream's.
UPSTREAM_DIR = os.path.join(ROOT, "extensions", "core", "upstream")
UPSTREAM = {
    line.split(" ", 1)[1].split("/")[1]
    for name in sorted(os.listdir(UPSTREAM_DIR))
    for line in open(os.path.join(UPSTREAM_DIR, name, "MANIFEST"), encoding="utf-8").read().splitlines()
    if line.endswith("/SKILL.md")
}

# gh 2.102 command groups and aliases that can write; search, status, browse,
# attestation, licenses and completion are read-only and stay open.
GH_WRITE_GROUPS = [
    "pr", "issue", "workflow", "run", "repo", "release", "label", "secret", "variable", "gist",
    "project", "ruleset", "cache", "codespace", "org", "auth", "config", "extension", "alias",
    "ssh-key", "gpg-key", "api", "co", "discussion", "agent-task", "skill", "copilot", "preview",
]
GIT_WRITE = [
    "push", "commit", "-C", "-c", "--no-pager", "--git-dir", "--work-tree", "format-patch", "checkout", "switch", "reset", "restore", "stash", "merge",
    "rebase", "pull", "clean", "rm", "mv", "add", "tag", "worktree", "branch", "cherry-pick",
    "revert", "am", "apply", "bisect", "config", "remote", "notes", "update-ref", "submodule",
    "clone", "init", "fetch", "gc", "prune", "filter-branch", "replace", "symbolic-ref",
]

# A read-only skill's blocklist: every write a fork must not make, the planted sentences' list.
WRITE_BLOCKLIST = {
    "Write", "Edit", "NotebookEdit", "Agent",
    "mcp__linear-shared__save_*", "mcp__linear-shared__create_*", "mcp__linear-shared__delete_*",
    "mcp__github-shared__create_*", "mcp__github-shared__merge_*", "mcp__slack-shared__chat_*",
    "Bash(git push:*)", "Bash(git -C:*)", "Bash(gh pr:*)", "Bash(gh issue:*)", "Bash(gh api:*)",
    "Bash(gh workflow:*)", "Bash(git checkout:*)", "Bash(git reset:*)",
    "Skill", "mcp__claude_ai_Claude_Docs", "mcp__notion", "mcp__datadog", "mcp__langsmith",
} | {f"Bash(gh {g}:*)" for g in GH_WRITE_GROUPS} | {f"Bash(git {c}:*)" for c in GIT_WRITE} | {
    # a prefix rule does not match the `--opt=value` spelling, so it needs its own rule
    "Bash(git --git-dir=*)", "Bash(git --work-tree=*)",
}

def bash_blocked(command, entries):
    """Whether a disallowed-tools Bash rule refuses a single command: a `:*` rule by its prefix
    as a whole word, any other rule as a glob over the whole command."""
    for entry in entries:
        bash = re.fullmatch(r"Bash\((.*)\)", entry)
        if not bash:
            continue
        rule = bash.group(1)
        if rule.endswith(":*"):
            prefix = rule[:-2]
            if command == prefix or command.startswith(prefix + " "):
                return True
        elif fnmatch.fnmatchcase(command, rule):
            return True
    return False


def blocks(entry, tool):
    """Whether a disallowed-tools entry covers a tool: exact, a glob, or a whole MCP server."""
    return entry == tool or (any(c in entry for c in "*?[") and fnmatch.fnmatchcase(tool, entry)) or tool.startswith(entry + "__")


SHELL_OPS = {"&&", "||", ";", "|", "&", "|&", "(", ")", ";;"}


def command_parts(command):
    """A command's parts between shell operators, read the way a shell would: a `|` or `;` inside
    quotes (a grep alternation, a sed script) stays in its word. Text a shell cannot read (an
    unclosed quote) is one part, as written."""
    try:
        lexer = shlex.shlex(command, posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        lexer.commenters = ""
        tokens = list(lexer)
    except ValueError:
        return [command.strip()] if command.strip() else []
    parts, current = [], []
    for token in tokens:
        if token in SHELL_OPS:
            parts.append(" ".join(current))
            current = []
        else:
            current.append(token)
    parts.append(" ".join(current))
    return [part for part in parts if part]


def blocked_mentions(body, entries):
    """The commands and tools a skill's body names, as code spans, lines of a fenced shell
    block, or a built-in tool by name ("the Skill tool"), that its own disallowed-tools
    blocks. One the same clause calls blocked ("`gh pr` is blocked here") is a warning,
    not an instruction, and is left out."""
    names = [(m.group(1).strip(), body[m.end():m.end() + 60]) for m in re.finditer(r"`([^`\n]+)`", body)]
    for block in re.findall(r"```(?:bash|sh|shell)\n(.*?)```", body, re.S):
        names += [(line.strip(), "") for line in block.splitlines() if line.strip()]
    hits = []
    for entry in entries:
        if re.fullmatch(r"[A-Z]\w+", entry):
            for m in re.finditer(rf"(?:`{entry}`|\b{entry} tool\b)", body):
                if not re.match(r"[^.;()]*?\b(?:is|are) blocked", body[m.end():m.end() + 60]):
                    hits.append((m.group(0), entry))
    # A compound command is refused whole when any part is blocked, so each part is judged on its own.
    parts = [(part, after) for name, after in names for part in command_parts(name)]
    for name, after in parts:
        if re.match(r"[^.;()]*?\b(?:is|are) blocked", after):
            continue
        for entry in entries:
            if entry.startswith("Bash("):
                if bash_blocked(name, [entry]):
                    hits.append((name, entry))
            elif name.startswith("mcp__"):
                if blocks(entry, name):
                    hits.append((name, entry))
            else:
                tool = re.fullmatch(r"mcp__[\w-]+?__(\w[\w*?]*)", entry)
                if tool and re.fullmatch(r"[a-z][a-z_]+", name) and fnmatch.fnmatchcase(name, tool.group(1)):
                    hits.append((name, entry))
    return hits


def yaml_error(path):
    """Parse the frontmatter as real YAML (PyYAML if installed, else ruby), as Claude
    Code does; the hand parser below would accept frontmatter that YAML rejects."""
    text = open(path).read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return "no frontmatter"
    try:
        import yaml  # type: ignore
        try:
            yaml.safe_load(m.group(1))
            return None
        except Exception as e:  # noqa: BLE001
            return str(e).splitlines()[0]
    except ImportError:
        pass
    if not shutil.which("ruby"):
        return "no YAML parser available (install PyYAML or ruby)"
    r = subprocess.run(["ruby", "-ryaml", "-e", "YAML.safe_load(STDIN.read)"], input=m.group(1), capture_output=True, text=True)
    return None if r.returncode == 0 else (r.stderr.strip().splitlines() or ["ruby YAML error"])[0][:160]


def frontmatter(path):
    text = open(path).read()
    m = re.match(r"---\n(.*?)\n---\n", text, re.S)
    if not m:
        return None, text
    fm, data, key = m.group(1), {}, None
    for line in fm.splitlines():
        top = re.match(r"([A-Za-z][\w-]*):\s*(.*)$", line)
        if top:
            key, val = top.group(1), top.group(2).split(" #")[0].strip().strip("\"'")
            data[key] = val if val else []
        elif key is not None and isinstance(data[key], list):
            item = re.match(r"\s+-\s+(.*)$", line)
            if item:
                data[key].append(item.group(1).strip().strip('"'))
            else:
                data[key].append(line)  # nested structure (hooks): keep raw lines
    return data, text


def main():
    fails = 0

    def check(ok, name, detail=""):
        nonlocal fails
        fails += not ok
        print(("PASS" if ok else "FAIL"), name, "" if ok else f"({detail})")

    skills = sorted(
        glob.glob(os.path.join(ROOT, "skills", "playground", "*", "SKILL.md"))
        + [
            path
            for path in glob.glob(os.path.join(ROOT, "extensions", "core", "skills", "*", "SKILL.md"))
            if os.path.basename(os.path.dirname(path)) not in UPSTREAM
        ]
    )
    check(bool(skills), "skills found", "no SKILL.md under skills/playground/<name>/")
    by_name = {}
    for path in skills:
        folder = os.path.basename(os.path.dirname(path))
        fm, _ = frontmatter(path)
        check(fm is not None, f"{folder}: has frontmatter")
        if fm is None:
            continue
        by_name[folder] = fm
        err = yaml_error(path)
        check(err is None, f"{folder}: frontmatter is valid YAML", err or "")
        check(fm.get("name") == folder, f"{folder}: name matches its folder", f"name={fm.get('name')!r}")
        body = open(path, encoding="utf-8").read()
        check(folder in COPIED or ("## Keep the skills learning" in body and any(f"`SendMessage` to `{to}`" in body for to in ("dispatcher",))),
              f"{folder}: sends what it learns to the dispatcher session")
        check(bool(fm.get("description")), f"{folder}: has a description")
        if "disallowed-tools" in fm:
            raw_background = re.search(r"^background:\s*false\s*$", open(path).read().split("\n---", 2)[0], re.M)
            check(fm.get("context") == "fork" and bool(raw_background),
                  f"{folder}: disallowed-tools only in a fork (context: fork, background: false)",
                  f"context={fm.get('context')!r} background must be the YAML boolean false")
            hits = blocked_mentions(body.split("\n---\n", 1)[-1], fm["disallowed-tools"])
            check(not hits, f"{folder}: names no tool its own disallowed-tools blocks", hits)

    planted = ["Read `gh api repos/o/r/pulls/1` for its reviewers.", "Then `save_issue`.", "```bash\ngit -C repo push\n```",
               "Call the Skill tool with claim.", "Write it with `Edit`.",
               "`gh pr` is blocked here, so use `gh search prs --owner o`.", "The Skill tool is blocked here.",
               # a compound read a headless scan sent on 6 Oct 2026, refused whole for its `git branch` part
               "`cd repo && git log -1 origin/develop && git branch --show-current && grep -rn parking src`",
               "```bash\ncd repo && git rev-parse --abbrev-ref HEAD | head -1; git push\n```",
               "`git rev-parse --abbrev-ref HEAD`, then `git log -1 --format='%h %cd' origin/develop`",
               # quoted operators stay in their word; a background & still splits
               "`grep -E 'x|git push origin' log`", "`date '+%a' | sed 's/AM/am/;s/PM/pm/'`", "`sleep 1 & git branch -a`"]
    caught = [bool(blocked_mentions(text, sorted(WRITE_BLOCKLIST))) for text in planted]
    check(caught == [True, True, True, True, True, False, False, True, True, False, False, False, True],
          "the blocked-tool check catches an instruction, a blocked part of a compound command, and passes over a warning", caught)

    ls = by_name.get("setup")
    check(ls is not None and str(ls.get("disable-model-invocation")).lower() == "true",
          "setup is user-invoked only (it installs software)", f"{ls and ls.get('disable-model-invocation')!r}")

    print("FAILURES:", fails)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())

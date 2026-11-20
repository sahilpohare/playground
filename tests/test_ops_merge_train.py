#!/usr/bin/env python3
"""scripts/ops/merge-train/run.py, merge-on-ready: sync() builds packages/ only when the reset moved something under it, and a cycle merges only once the scan's fingerprint moves.

Every git and gh call is a stub, HOME is a scratch folder, and the job's heartbeat, settings reads and main loop never run, so
nothing reaches the main checkout or the live state folder. Run: python3 tests/test_ops_merge_train.py
"""
import json
import os
import sys
import tempfile
import types
import unittest

# The live job holds run.lock and imports beat from ops/, so both are stubbed before run.py's source runs.
fcntl_stub = types.ModuleType("fcntl")
fcntl_stub.LOCK_EX, fcntl_stub.LOCK_NB = 2, 4
fcntl_stub.flock = lambda *a, **k: None
sys.modules["fcntl"] = fcntl_stub
beat_stub = types.ModuleType("beat")
beat_stub.beat = lambda *a, **k: None
beat_stub.checkout = lambda: "/checkout"
beat_stub.gh_down = lambda: None
sys.modules["beat"] = beat_stub

# the settings reads run bun when run.py loads, and the job's own main loop is top-level code from run.py's `while True:` on, which the test must never run, so both come out.
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "scripts", "ops", "merge-train", "run.py")
src = open(path).read()
pairs = [
    ('REPO = setting("factory.repo")', 'REPO = "acme/factory"'),
    ('CYCLE = setting("jobs.opsMergeTrain")["schedule"].get("every", 60)', "CYCLE = 60"),
]
for old, new in pairs:
    assert src.count(old) == 1, old
    src = src.replace(old, new)
src = src[: src.index("\nwhile True:")]
# run.py keeps its lock and log in the state folder under HOME, so HOME is a scratch folder and the live one is never touched.
scratch = tempfile.TemporaryDirectory()
os.environ["HOME"] = scratch.name
os.makedirs(os.path.join(scratch.name, ".playground", "ops", "merge-train"))
ns = {"__name__": "run_under_test"}
exec(compile(src, path, "exec"), ns)

BUILD = ["bun", "run", "turbo", "run", "build", "--filter=./packages/*"]
INSTALL = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]


class FakeSh:
    """git's answers only: diff --quiet exits 1 when the path moved, what sync() branches on."""

    def __init__(self, packages, lock):
        self.calls = []
        self.packages, self.lock = packages, lock

    def __call__(self, argv, timeout=900):
        self.calls.append(argv)
        if argv[:2] == ["git", "rev-parse"]:
            return 0, "1111111111111111111111111111111111111111\n", ""
        if argv[:2] == ["git", "diff"]:
            moved = self.lock if argv[-1] == "bun.lock" else self.packages
            return (1 if moved else 0), "", ""
        return 0, "", ""


def run_sync(fake):
    original = ns["sh"]
    ns["sh"] = fake
    try:
        ns["sync"]()
    finally:
        ns["sh"] = original
    return fake.calls


class MergeReady(unittest.TestCase):
    def ready_with(self, answer):
        told, sent = [], []
        saved = {k: ns[k] for k in ("train", "tell_owner", "tell_lead", "log")}
        ns["train"] = lambda *args, timeout=900: answer
        ns["tell_owner"] = lambda n, text: told.append((n, text))
        ns["tell_lead"], ns["log"] = sent.append, lambda line: None
        try:
            return ns["merge_ready"](), told, sent
        finally:
            ns.update(saved)

    def test_a_pr_pr_train_ready_merged_is_told_to_its_owner_and_the_lead(self):
        out = '{"merged": {"n": 7, "sha": "abcdef1234", "why": "2 checks passed"}, "refused": []}'
        detail, told, sent = self.ready_with((0, out, ""))
        self.assertEqual(detail, "merged #7 on ready as abcdef1")
        self.assertEqual(told, [(7, "#7: merged on ready as abcdef1")])
        self.assertEqual(sent, ["merged #7 abcdef1 (merge-on-ready)"])

    def test_nothing_merged_or_a_failed_run_merges_nothing(self):
        self.assertEqual(self.ready_with((0, '{"refused": []}', ""))[0], None)
        self.assertEqual(self.ready_with((1, "", "boom"))[0], None)


class Cycle(unittest.TestCase):
    def cycle_with(self, fp, rebuild=False, down=None):
        calls = []
        saved = {k: ns[k] for k in ("sync", "fingerprint", "merge_ready", "gh_down")}
        saved_state = dict(ns["state"])
        ns["sync"] = lambda: None
        ns["gh_down"] = lambda: down
        ns["fingerprint"] = lambda: (calls.append("fingerprint"), fp)[1]
        ns["state"].update(fingerprint="same", rebuild_now=rebuild)
        ns["merge_ready"] = lambda: (calls.append("merge_ready"), None)[1]
        try:
            return ns["cycle"](), calls
        finally:
            ns.update(saved)
            ns["state"].clear()
            ns["state"].update(saved_state)

    def test_an_unchanged_fingerprint_merges_nothing(self):
        self.assertEqual(self.cycle_with("same"), (("ok", "nothing changed since the last scan"), ["fingerprint"]))

    def test_a_moved_fingerprint_or_a_merge_asks_pr_train_ready(self):
        self.assertEqual(self.cycle_with("moved"), (("ok", "no PR ready to merge"), ["fingerprint", "merge_ready"]))
        self.assertEqual(self.cycle_with("same", rebuild=True)[1], ["fingerprint", "merge_ready"])

    def test_a_list_gh_cannot_read_skips_the_cycle(self):
        self.assertEqual(self.cycle_with(None)[1], ["fingerprint"])

    def test_a_failed_gh_sign_in_probe_skips_gh_for_the_cycle(self):
        # the train's list call each minute against a locked keyring helped flood it
        self.assertEqual(self.cycle_with("moved", down="gh token invalid"), (("ok", "skipped: gh unreachable: gh token invalid, next cycle"), []))


class Fingerprint(unittest.TestCase):
    def fingerprint_with(self, conclusion):
        pr = {"number": 7, "headRefOid": "a" * 40, "updatedAt": "2026-10-30T00:00:00Z", "isDraft": False, "statusCheckRollup": [{"name": "test", "status": "COMPLETED", "conclusion": conclusion}]}
        saved = ns["sh"]
        ns["sh"] = lambda argv, timeout=900: (0, json.dumps([pr]), "") if argv[0] == "gh" else (0, "c" * 40 + "\n", "")
        try:
            return ns["fingerprint"]()
        finally:
            ns["sh"] = saved

    def test_a_check_that_finishes_moves_the_fingerprint_though_updated_at_stays(self):
        self.assertNotEqual(self.fingerprint_with(None), self.fingerprint_with("SUCCESS"))


class Sync(unittest.TestCase):
    def test_a_reset_that_touches_packages_builds(self):
        calls = run_sync(FakeSh(packages=True, lock=False))
        self.assertIn(BUILD, calls)
        self.assertNotIn(INSTALL, calls)

    def test_a_reset_that_leaves_packages_skips_the_build(self):
        calls = run_sync(FakeSh(packages=False, lock=False))
        self.assertNotIn(BUILD, calls)

    def test_a_moved_lockfile_still_installs(self):
        calls = run_sync(FakeSh(packages=False, lock=True))
        self.assertIn(INSTALL, calls)
        self.assertNotIn(BUILD, calls)


if __name__ == "__main__":
    unittest.main(verbosity=2)

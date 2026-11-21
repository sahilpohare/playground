---
name: doc-sync
description: Sync docs and skills so they never drift from the code. Use before opening or updating a PR, or when a change touches a command, path, convention, or the skill set a doc or skill documents.
source: https://github.com/nrjdalal/zerostarter
---

> [!CAUTION]
> Synced from https://github.com/nrjdalal/zerostarter. Customize this skill or remove this note to stop syncing.

# Doc Sync

A change ships with its docs or it ships drift. This is the procedure that catches drift across every hand-authored surface before the PR goes up: `AGENTS.md` makes the sync mandatory, this makes it checkable.

## Surfaces

Hand-authored, keep each in step with the code:

| Surface | Documents | Drifts when |
| --- | --- | --- |
| `web/next/content/docs/**.mdx` | concepts and how-to (getting-started, deployment, manage, resources) | a feature, convention, API, command, script, or env var it describes changes |
| `web/next/docs.config.ts` | the docs nav and page registry, the single source the sidebar, `meta.json`, and MDX frontmatter all derive from | a doc page is added, removed, renamed, or re-slugged |
| `README.md` | top-level story: stack, structure, quick start, scripts, deployment | the stack, setup, scripts, or pitch changes |
| `.agents/skills/<name>/SKILL.md` | one task procedure each (canonical; `.claude` and `.github` symlink in) | a command, path, convention, or tooling a skill encodes changes, or a skill is added or removed |
| `AGENTS.md` (`CLAUDE.md` symlinks in) | the rules; ships to every fork whole, so a rule must read true there too | a rule changes |
| `.agents/dashboard/<topic>.md` | the dashboard app's rules, one file per topic, each reached from `AGENTS.md` by a pointer naming when to read it, each ALWAYS rule also there in one line | a dashboard rule changes: edit the topic file that holds it, and its one-line form in `AGENTS.md` when its meaning moves; a new topic file gets its pointer, and a new ALWAYS rule its line under that pointer |
| `.agents/testing.md` | the test suite's reference (the sandbox, the parallel pass, its traps), reached from `AGENTS.md`'s test rule by a pointer | the suite's runner or its sandbox changes |
| `scripts/README.md`, `scripts/hooks/README.md` | spawn.sh's and ops-herdr's full rules, each reached from its one line in `AGENTS.md`, and the factory hooks', one section per hook, each named in `AGENTS.md`'s hooks pointer | a hook, spawn.sh or ops-herdr changes: edit its section, and spawn.sh's or ops-herdr's line in `AGENTS.md` when its meaning moves; a new hook gets a section and its name in that pointer |
| `packages/config/src/site.ts` | the brand, the feature flags, and the hand-written preamble served at the top of `/llms-full.txt` | the layout, the route groups, the packages, or the API surface it describes changes |

Generated, never hand-edit (they regenerate from the surfaces above): `content/docs/meta.json` (git-ignored), the `/llms.txt` and `/llms-full.txt` routes, and the fumadocs search index. The one hand-written part of those routes is the `/llms-full.txt` preamble, which lives in `site.ts` above.

## 1. Scope the change

List what the diff touched: paths, commands, script names, env vars, conventions, tooling, and whether the skill set changed. Start from `git diff --stat` and the code diff.

## 2. Hunt drift

Grep every surface for each changed path, command, or symbol; every hit is a candidate:

```bash
rg -n "<changed-path-or-command>" web/next/content/docs README.md AGENTS.md .agents/dashboard .agents/skills .agents/testing.md scripts/README.md scripts/hooks/README.md web/next/docs.config.ts
```

A term whose meaning changes (a behaviour, a rule, what a command does) is also written in other words, which a grep on its name misses.
Read each doc line the first grep hits, note every other wording it uses for the same rule, and grep each wording too: a grep for `slots gate` leads to lines that say `free run slot` and `run-slot lane free`, and each of those takes its own grep.
One PR's grep on a rule's name alone missed three such lines, which took two review rounds.
Done when every wording has had its grep and each hit on the old meaning is fixed.

## 3. Sync, coupled surfaces included

Fix each hit in the same change. Before the first edit to an agent-facing surface (a `SKILL.md` or a file beside it, `AGENTS.md`, an `.agents/dashboard` file, `.agents/testing.md`, `scripts/README.md` or `scripts/hooks/README.md`, a `docs/<bucket>/<name>.md` page), call the Skill tool with `writing-for-agents` when it is installed, and follow it; that page also follows `.agents/writing-docs.md` where that file exists. Three couplings are easy to miss:

- **Adding or removing a skill** touches the skills table in `skills/zerostarter/README.md` (generated, so run `bun packages/scripts/src/skills-manager.ts`). A vendored one also touches `skills-lock.json` when it is a stub pinned for integrity (`agent-browser`); one copied in full (`portless`) has no lock entry.
- **Adding, removing, or renaming a doc page** touches `web/next/docs.config.ts`, not the `.mdx` alone.
- **Editing a wrapped doc** (`PATTERNS` in `packages/scripts/src/docs-wrap/cli.ts`) means one sentence per line, a sentence over 400 characters broken at a comma, colon or semicolon: run `bun run docs:wrap` after the edit, and its `--check`, which pre-commit and `test:skills` run, passes.

## 4. Verify with the repo's own drift gate

```bash
bun packages/scripts/src/docs.ts --strict
```

This is the fast gate (seconds): it exits non-zero on any `.mdx` missing from `docs.config.ts`, any config entry with no file, or frontmatter drifted from `docs.config.ts`. To fix a failure, run it without `--strict` to rewrite the managed frontmatter and scaffold missing pages, then commit. Before the PR, also run `cd web/next && bun run build` once: it reruns this check inside the full build, and additionally catches type errors and rebuilds the search index. Done when the strict gate passes AND a fresh `rg` for every removed or renamed path, command, and skill name finds zero stale mentions across the surfaces.

## Notes

- Skills are symlinked: `.agents/skills` is canonical, so edit once.
- The `/llms.txt` and `/llms-full.txt` routes mirror the docs and regenerate at build, so fix the doc, never the route.

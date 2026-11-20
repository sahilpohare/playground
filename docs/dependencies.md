# bun audit

> [!NOTE]
> This file is the canonical record of dependency-audit overrides/exceptions (`bun audit --audit-level moderate` runs in the pre-push hook on canary). It intentionally exists even when no overrides are required, do not delete it.

> bun audit --audit-level moderate

## Catalog ranges

Every `catalog` entry uses a caret range, and `packages/scripts/src/deps-manager.ts` enforces it on `postinstall`:

- An exact version (`1.2.3`), a partial (`4.7`, `5`) or a tilde (`~1.2.3`) is rewritten to a caret, and each change is printed under `[INFO] Normalized catalog ranges to caret`.
- Normalization runs _after_ the auto-move step, so a spec promoted into the catalog from a workspace dep is caught in the same run. That matters because `bun add` writes a workspace dep, and `bun add -E` writes an exact one.
- Anything it cannot convert safely is left untouched and reported under `[INFO] Catalog ranges that are not caret and cannot be converted safely`: compound ranges (`>=4.4.3 <5`), wildcards (`2.x`), and dist-tags (`latest`). Fix those by hand.
- Non-range specs are skipped silently, since a caret is meaningless for them: `workspace:`, `file:`, `link:`, `portal:`, `npm:` aliases, `github:owner/repo`, and git or http URLs.

Rewriting a spec after resolution leaves `bun.lock` holding the old spec string until the next install, so the first `bun install` after a pin fixes `package.json` but leaves the lockfile one step behind. A second `bun install` heals it. Committing the intermediate state is harmless: `bun install --frozen-lockfile` compares the resolved package set rather than the recorded spec, verified to pass in both directions without rewriting the lockfile. This matters because `auto-labeler.yml` installs with `--frozen-lockfile`.

Note that a caret on a prerelease widens it more than it may look: `^2.0.14-beta.1` admits `2.0.14-beta.2` and every later `2.x`. A prerelease is the one spec most often pinned on purpose, so if an exact prerelease matters, record the reason here before the rule rewrites it.

The rule has **no opt-out**, so no pin survives an install, whatever reason is recorded here. Pinning something deliberately means changing the rule itself in `packages/scripts/src/deps-manager.ts`, for example adding an allowlist it skips, and writing down why in this file. That was left out on purpose: there is nothing to exempt today, and an unused config key is worse than adding one when a real case appears.

Enforcement is only partial by design. Specs the rule cannot convert are reported and the script still exits 0, so a compound range such as `>=4.4.3 <5` survives an install with nothing but a line of `postinstall` output. Failing the install instead would block work for a range that may be perfectly deliberate, so the auto-convertible half is enforced and the rest is advisory.

## Pinned actions and installers

What the factory fetches from outside the lockfile runs at one known version, and `tests/github/workflows/pins.test.ts` holds each pin:

- **A GitHub action:** every `uses:` in `.github/workflows/` and `.github/actions/` names a full 40-character commit sha, with the tag it stands for in a trailing comment (`uses: actions/checkout@<sha> # v7`). A local action (`./...`) needs none, and a `docker://` image takes a `@sha256:` digest. Every workflow also declares a top-level `permissions` block.
  To bump one, read the new tag's sha from the action's own repo, `gh api repos/<owner>/<action>/git/ref/tags/<tag> --jq .object`, and when its `type` is `tag`, peel it to the commit with `gh api repos/<owner>/<action>/git/tags/<sha> --jq .object.sha`. Then write that sha and the new tag's comment on every line that uses the action.
- **The runner host's installers:** `scripts/ops/runner-host/setup.sh` pins `BUN_VERSION`, `UV_VERSION` and `RUNNER_VERSION`, and its `fetch` checks each download's sha256 (`*_SHA256`, one per architecture) before it unpacks it, stopping on a mismatch.
  To bump one, change the version and both architectures' sums, taken from the release's own published sums (`gh api repos/<owner>/<repo>/releases/tags/<tag> --jq '.assets[] | [.name, .digest]'`), and cross-check them against its sums file where it ships one (bun's `SHASUMS256.txt`, uv's `<asset>.sha256`, the runner's release notes). `BUN_VERSION` follows `package.json`'s `packageManager`, which `tests/bun-version.test.ts` holds.
- **inscope:** `AGENTS.md` runs `npx -y inscope@<version>`. To bump it, change that one version to the release `npm view inscope version` names.
- **inscope's synced skills:** each entry in a workspace's `skills` in `~/.config/inscope/inscope.json` names a commit, in inscope's object form `{ "source": "<owner>/<repo>", "path": "<subdir>", "ref": "<sha>" }`, since the string form `<owner>/<repo>#<path>` takes no ref; the file lives in the home folder, so no test holds these pins.
  `inscope skill update` skips a pinned entry, so to bump one, read the repo's new head (`gh api repos/<owner>/<repo>/commits/<branch> --jq .sha`) and the upstream diff on the skill's own path since the pinned sha (`gh api repos/<owner>/<repo>/compare/<pinned>...<new> --jq '.files[] | select(.filename | startswith("<path>/")) | .filename, .patch'`), then set `ref` to the new sha and run `npx -y inscope@<version> apply`; done when `npx -y inscope@<version> diff` reads "In sync" and the skill's link sits in its `@<new sha>` folder.
  Copy the file to `inscope.json.bak-<YYYYMMDD>` beside it before the edit; to undo, put that copy back and run `apply` again.

## Notable dependencies

### `@pierre/diffs` (`^1.6.2`, web)

- **What:** draws a `.diff` or `.patch` attachment in the Inbox's viewer as a patch view (`web/next/src/components/dashboard/viewer/patch-view.tsx`). Apache-2.0, from `pierrecomputer/pierre`.
- **Cost:** about 101 KB gzip with its own Shiki highlighter (measured on 1.6.2 with `bun build --minify`, React external), loaded through `next/dynamic` only when a patch opens, so no other page carries it; `tests/web/next/src/components/dashboard/viewer/patch-view.test.ts` fails when any other file imports it.
- **Watch:** a fast-moving 1.x (17 publishes in the 90 days to 2 Nov 2026) under a caret range; a minor that changes `FileDiff`'s options or `parsePatchFiles` shows in that test and in the viewer's own fallback to text, which takes any render the package throws on.

### `next`: its agent upgrade stop is off (web)

- **What:** `web/next/next.config.ts` sets `experimental.agentUpgrade: false`. Left at its default, `'security'`, `next build` in an agent session stops with `SecurityFatalError` whenever npm's advisory feed lists the installed Next. It skips the stop with no agent and no TTY, so CI stays green while every session's pre-commit build stops, as it did on 16 Nov 2026 for about 90 minutes at 16.4.3 ([GHSA-mfr8-8qww-v76h](https://github.com/advisories/GHSA-mfr8-8qww-v76h)).
- **Trade:** a new Next advisory no longer fails `next build`. The audit gates catch it instead, at moderate or worse: a PR's Audit step when the PR adds it (`audit.ts --new-over`), `audit-canary.yml`'s run and its `canary audit` issue at `canary`'s next push when it lands on a Next that `canary` already holds (a PR only prints that one as a notice), and the pre-push `audit` on a direct push to `canary`. Each must keep failing on a moderate-or-worse Next advisory, and none ignores one.
- **Watch:** `tests/web/next/next.config.test.ts` fails when a ZeroStarter sync or a Next upgrade drops the key, and when an env schema or `turbo.json` passes `__NEXT_AGENT_UPGRADE`, which Next reads ahead of the config, to a build.

## Active overrides

### `seroval` → `^1.6.8`

- **Advisory:** [GHSA-p6vx-979v-rg4c](https://github.com/advisories/GHSA-p6vx-979v-rg4c) (critical): `fromJSON()` Promise thenable assimilation invokes plugin-produced callables, a bypass of GHSA-mv8w-475r-vwqw; affects `>=0.12.0 <=1.6.0`. And [GHSA-jp82-f5mq-hwhp](https://github.com/advisories/GHSA-jp82-f5mq-hwhp) (high): memory exhaustion through an unchecked TypedArray length in JSON deserialization; affects `<=1.6.2`.
- **Why an override:** `@tanstack/query-devtools` brings in `solid-js` (`better-auth` lists it only as an optional peer), and `solid-js@1.9.15`, the latest stable, declares `seroval: ~1.5.4`, which `bun audit fix` reports as blocked by a dependent's range. The latest parents, `@tanstack/react-query-devtools@5.104.1` and `better-auth@1.7.7`, change nothing: the devtools still need `solid-js ^1.9.15`, and `solid-js` 2.x, which declares `seroval ~1.6.7`, is out of reach under that range. `seroval-plugins@1.5.6` stays, as its peer range is `seroval ^1.0`.
- **Risk:** low. Nothing here imports `solid-js` or better-auth's Solid client. It is installed for `@tanstack/query-devtools`, the Solid panel the web app mounts only outside production (`web/next/src/app/providers.tsx`). Only `solid-js/web`'s server build imports `seroval`, to serialize, and nothing here passes untrusted input to its `fromJSON`. `seroval-plugins@1.5.6` imports only `createPlugin`, which 1.6.8 keeps, and the suite, build and `bun run verify all` pass on it.
- **Exit criteria:** remove once the `solid-js` that `@tanstack/query-devtools` resolves declares a `seroval` range that resolves `>=1.6.3` on its own.

### `shell-quote` → `^1.11.0`

- **Advisory:** [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) (critical): `quote()` command injection via a line terminator in a token after a `{ comment }` token. Affects `shell-quote >=1.8.4 <1.11.0`.
- **Why an override:** `concurrently@10.0.5`, the latest, declares `shell-quote` at exactly `1.9.0`, so neither `bun update` nor a parent bump can lift it.
- **Risk:** low. `concurrently` runs only in `@api/hono`'s `dev:app` script, with commands written in its `package.json`, never untrusted input; `1.11.0` is a minor release of the same API, and `bun run test` and the build pass on it.
- **Exit criteria:** remove once `concurrently` declares a `shell-quote` range that resolves `>=1.11.0` on its own.

## Patched dependencies

A patch lives in `patches/`, made with `bun patch <pkg>` and registered under `patchedDependencies` in the root `package.json`, which `turbo prune` carries into the Docker build.

### `next-themes@0.4.6`

- **Bug:** its `ThemeScript` renders the inline theme script on every render, so when React renders the root on the client (after a hydration mismatch, such as one a browser extension causes by adding a node), React 19 logs "Encountered a script tag while rendering React component" ([pacocoursey/next-themes#385](https://github.com/pacocoursey/next-themes/issues/385)).
- **Patch:** `ThemeScript` returns `null` when `window` exists, the change in the open [pacocoursey/next-themes#386](https://github.com/pacocoursey/next-themes/pull/386). The server's HTML still carries the script, so the theme is set before the first paint; `tests/patches/next-themes.test.ts` holds both halves.
  It relies on `NextThemesProvider` (`InnerProvider` in `web/next/src/app/providers.tsx`) staying a direct child of `<body>`, where React skips the server-only script while hydrating; inside a `<div>`, every load fails hydration (measured on Next 16.4.3 and React 19.3.1), and the test, which never hydrates, stays green.
- **Risk:** low. The patch is keyed to `0.4.6` exactly, so a bump of next-themes stops applying it, and the test's second case going red is what says so.
- **Exit criteria:** remove the patch, its `patchedDependencies` entry and its test once a next-themes version ships that pull request's fix or an equivalent one.

## Ignored advisories

Every audit gate fails on a moderate advisory or worse. An advisory that no update, parent bump or safe override can clear, since every parent's latest still pins an affected range, is ignored by ID instead. Each `--ignore` sits in all four gates, `lefthook.yml`, `.github/workflows/auto-check-build.yml`, `.github/workflows/audit-canary.yml` and `scripts/ops/runner-host/suite.sh`, and `tests/github/workflows/audit.test.ts` holds those four to the IDs headed below. Remove an ID from all four, with its block here, when its exit criteria are met.

### `esbuild` ([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99))

- **Advisory:** moderate: esbuild's development server (`esbuild --serve`) answers any website's request, so a page open in the browser can read what it serves. Affects `esbuild <=0.24.2`; patched in `0.25.0`.
- **Why an ignore:** the tree's `esbuild@0.18.20` comes only through `drizzle-kit@0.31.11` (the latest) > `@esbuild-kit/esm-loader@2.6.5` > `@esbuild-kit/core-utils@3.3.2`, which pins `esbuild ~0.18.20` and is deprecated with no later release. An override by name would also move the tree's other copies (`0.25.12` and `0.28.2`) to one range, across esbuild's breaking releases for `fumadocs-mdx` and `tsdown`'s `tsx`.
- **Risk:** negligible. The copy loads `packages/db`'s config for the `drizzle-kit` CLI (`bun run db:generate`, `db:migrate`, `db:studio`), a dev dependency that only transforms code and never starts esbuild's server; nothing the api bundle or the web app ships imports it.
- **Exit criteria:** drop the ignore once a `drizzle-kit` past `0.31.11` drops `@esbuild-kit/esm-loader` (it declares `^2.5.5`, and `2.6.5`, the latest, holds `@esbuild-kit/core-utils@3.3.2` and its `esbuild ~0.18.20`), or the tree resolves no `esbuild` below `0.25.0`.

### `minimatch` ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249))

- **Advisory:** moderate: denial of service through glob-part amplification in a crafted pattern. Affects `minimatch >=7.0.0 <11.0.1`; patched in `11.0.1`.
- **Why an ignore:** the tree's `minimatch@10.2.6` comes only through `@ts-morph/common`, at `0.29.0` under `ts-morph@28.0.0` (the latest) and `0.27.0` under `shadcn@4.22.1`'s `ts-morph ^26` (`4.23.0`, the latest, declares the same); both declare `minimatch ^10.0.1`, so the fix is a major away and an override would cross it under them.
- **Risk:** negligible. `ts-morph` runs only in dev tooling: `packages/scripts/src/shadcn-customize.ts` and the `shadcn` CLI behind `bun run shadcn:update`, each on the repo's own fixed globs, never a pattern from untrusted input.
- **Exit criteria:** drop the ignore once a `@ts-morph/common` past `0.29.0` (reached by `ts-morph` past `28.0.0`, and by a `shadcn` past `4.23.0`, whose `ts-morph ^26` holds `0.27.0`) declares a `minimatch` range that resolves `>=11.0.1`, or the tree resolves no `minimatch` below it.

## Retired overrides

The starter's own history of retired overrides lives in [nrjdalal/zerostarter's record](https://github.com/nrjdalal/zerostarter/blob/main/.github/notes/dependencies.md); a returning advisory is checked there before `package.json` changes.

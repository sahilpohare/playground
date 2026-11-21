# Deploying through the Vercel CLI

A factory session's `vercel` call passes the no-raw-vercel guard first ([scripts/hooks/README.md](../../../../scripts/hooks/README.md#no-raw-vercel)), which allows reads by name and refuses every other call.
It runs `whoami`, `ls`, `inspect`, `logs`, help, the `ls` of `alias`, `dns`, `domains`, `integration`, `project` and `teams`, `env ls` without its values, `promote status`, `rollback status`, `rolling-release inspect`, a `vercel api` GET outside `/env`, and a preview deploy (`vercel deploy`, or `vercel ./<folder>`).
A production move (a production deploy, a `redeploy` into production, a `promote`, `rollback`, alias change or rolling release step) passes for the Ops lead alone, since production ships from `main` through the release skill, whose step 4 deploys the hosted Yard with `bun run ship:yard <tag>`, a production move too.
Every other call, `link` and `integration add` among them, is refused in the factory.

Three traps one CLI deploy met (measured), each a step at the command it follows.

1. **Keep the development env off disk.**
   Outside the factory, where the guard passes it, run `vercel integration add <name> --no-env-pull`, since without the flag it pulls the project's development env, a client secret among it, into `.env.local` (`--no-env-pull` skips that pull, by `vercel integration add --help` on vercel 65.8.0).
   In the factory, name the project on each call with `--project <name>` in place of a link.
   Outside it, run `rm -f .env.local` right after `vercel link`, in the folder you ran it from, since link pulls the same env there and takes no such flag (its `--help` on 65.8.0), and one deploy found a client secret in a scratch folder that way.
   Done when `ls .env.local` finds no file.
2. **Read `vercel api` through its JSON alone.**
   Pipe it as `vercel api --raw <path> | grep -o '{.*' | jq`, since the CLI can print a warning line before its JSON, and a bare `| jq` stops on that line with "Invalid numeric literal".
   Done when jq prints the object.
3. **Probe a function that answers nothing.**
   Read an empty `vercel logs` as unknown: it returned 0 records for a function that hung about 60 s at its default export, a Node server that had already called `listen()`, so it shows neither a request nor its absence.
   Deploy a minimal Hono probe, one route that returns a word, to a preview, then move it toward the real handler one difference a preview (an import, the export's shape, a runtime setting), since that found the hang's cause faster than the logs did (12 probes in about 16 minutes, measured from their deploys' createdAt).
   For a Node server export, export it unlistened: `createAdaptorServer` from `@hono/node-server`, never `serve()`, which calls `listen()`, since all 8 probe deploys built on 31 Oct whose export already listened hung, while a deploy of the same code built on 24 Oct still answered 200 on 31 Oct.
   An unlistened `http.createServer()` and `createAdaptorServer()` each answered 200 in 1.2 s, and that `http.createServer()` server hung 62 s once it had called `listen(3000)` (measured, 31 Oct).
   Done when the first preview that hangs names that difference.

# Model-invoked vs user-invoked

Every `SKILL.md` is one of two kinds, split by who can reach it:

- **User-invoked**: only the human typing its name. Set `disable-model-invocation: true` in the frontmatter. The `description` is a one-line summary for a person browsing slash commands. A typed invocation arms its hooks, and a worker that Reads a skill with no `hooks:` follows the step its brief names ([DISPATCH.md](../extensions/core/skills/playbook/DISPATCH.md)).
- **Model-invoked**: the default, reachable by the model or the user. The `description` is model-facing: front-load the leading word, and give each distinct trigger one phrase.

The test: could the agent usefully reach for this skill on its own? `code-review-loop` is model-invoked, its frontmatter setting no `disable-model-invocation`, because a session asked to review or re-review a PR should load it.

When one skill needs another, it says so as an instruction: `Call the Skill tool with "<name>"`, one skill per call.

A read-only skill enforces it with `disallowed-tools`, and only inside a fork (`context: fork`, `background: false`): there the block ends when the skill does, while on the main thread it would last the rest of the turn and strand the skill that called it ([ADR 0002](./adr/0002-a-read-only-skill-runs-as-a-fork.md)). A skill with a few writes uses the same fork and blocks everything else but those writes, as a made-up `todo-close` would leave its one close call open ([ADR 0003](./adr/0003-a-fork-leaves-only-its-named-writes-open.md)). A forked skill the user types shows its result as command output under the prompt; when the result should read as a normal reply, put an inline skill in front that calls the fork and prints its result, as a made-up `todo` would for its forked `todo-scan`. A fork that needs MCP servers its caller's checkout turns off is started headless from a checkout where they load, through a script, as `todo`'s own `scan.sh` would start `todo-scan`. A fork a job types headless keeps the default `user-invocable`, since Claude Code answers a typed `/<name>` of a `user-invocable: false` skill with a refusal and no run: `todo-scan`, which a job types as `/todo-scan`, stays user-invocable and needs no Skill call. `bun run test:skills` checks this pairing.

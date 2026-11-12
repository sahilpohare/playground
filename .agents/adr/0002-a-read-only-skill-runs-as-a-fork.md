# A read-only skill runs as a fork

This decision was an org's ticket skill's, so it lives in that org's extension (`playground ext show <org> doc adr-0002`), and core keeps its finding, measured in live `claude -p` runs on Claude Code 2.1.286: `disallowed-tools` on the main thread blocks its tools until the turn ends, the calling skill's included, while inside a fork (`context: fork`, `background: false`) it blocks only inside the skill, enforcing an exact MCP tool name, a glob, a whole server and a Bash prefix (the direct form alone) as written.

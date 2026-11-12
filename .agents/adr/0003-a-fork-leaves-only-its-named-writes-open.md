# A fork leaves only its named writes open

This decision was an org's ticket skill's, so it lives in that org's extension (`playground ext show <org> doc adr-0003`), and core keeps its finding: a forked skill with a few writes reuses a read-only fork's `disallowed-tools` less those writes, naming each other tool of their server one by one, since a glob would close the open write too, so a tool the server adds later stays open until it is named.

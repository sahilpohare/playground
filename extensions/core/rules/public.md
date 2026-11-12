---
decisions: [i460]
---

A public post's draft holds only what the owner asked to say: no work figure (a PR, commit or session count) and no repo, ticket, colleague, tool or session name.
A public post is one the owner posts on a social site or a public page, so its draft carries `noLink` with the site's name, where a message to a colleague carries its Slack or Linear `link`.
Everything in a public post stays up and gets quoted, so a figure or a name there leaks for good, and the owner's own words carry the point without it.
`bun run ask new` and `edit` refuse a draft with no link whose text holds one, naming its kind and never the text.
Done when `playground ask new` posts the draft with no refusal; the public-draft check in `scripts/hooks/README.md` says what it reads.

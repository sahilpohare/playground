## What it does

`to-inbox` is how a factory session writes every message to the owner so the owner reads it at a glance: an Inbox item, a dispatcher's reply in chat, or a Slack or Yard DM.
Each leads with a picture of the point and a short note, then a few bullets in [plain words](./plain-words.md), and a card ends on what Approve does.
The **talk** rule makes this the one shape for every word to the owner.
It holds the words and pictures alone; the item's shape, its kinds and the `playground ask` commands stay in [.agents/dashboard/asks.md](../../.agents/dashboard/asks.md), which it points at rather than copies.

The defining constraint is the card itself: it sits in the aside's narrow column and is read in seconds, so every drawing keeps within the card's width (`ASK_CODE_COLUMNS`), every sentence passes [plain-words](./plain-words.md)' two rules, and a UI to be built goes in as a sketch, or as a page to click, never a paragraph about it.

## When to reach for it

Agent-fired: a session loads it before every `playground ask new` and before it writes to the owner, and the owner can name it too.
A message outside the Inbox takes the same picture and note, bullets, plain words, callout and fake-data check, and leaves out the card's choices and its post; a relay in chat, the dispatcher passing a session's message on, is one of them.
In chat the picture is a fenced block, since a table or a list of three or more numbered steps goes in an Inbox card, unless every row or step names an issue or PR.

| You are posting                                               | What it leads with                                                      |
| ------------------------------------------------------------- | ----------------------------------------------------------------------- |
| A decision about a code change                                | a `diff` block of the lines that change                                 |
| A decision about a flow or a plan                             | an ASCII drawing                                                        |
| A UI change                                                   | before and after shots in one group                                     |
| A UI not yet built, or a demo                                 | an HTML page                                                            |
| A job of several steps                                        | a work status block, edited as steps land                               |
| Something to look at, with no answer                          | an update with text and files, read-only                                |
| A plain update, or a ship or schema decision                  | its fields alone, under a plain title                                   |
| An accept, apps, budget, delete, grant, guard or own decision | its why as plain lines, one fact each, a delete's linking what it names |
| A draft or a Slack decision                                   | the message, with any files under its words                             |
| A public post's draft, with no link                           | the post itself, with `noLink` naming its site                          |
| A ticket decision                                             | the ticket itself, in its own shape                                     |
| A secret ask                                                  | its key and sink alone, under a plain title                             |
| A reveal card                                                 | the item's full service and one plain why line, under a plain title     |

The kind also decides how the card closes.
A decision or a draft the session decided another way is settled.
An update its session has settled is resolved by that session: an alert that fixed itself, a progress card whose last step is done.
Until then an update stays editable, unless you dismiss it, so a card the session will replace, such as a mock's first version, is edited in place before then.

An ask or an update about the factory's own work carries `scope: "factory"`, so it can reach you on WhatsApp too; any other card stays in the Inbox.

## The card it writes for

```
picture   diff, ASCII, shots, page
note      one sentence on the point
bullets   🐛 ✅ ⚠️ ↩️ 📨 🕐 ⏱️ 💰, one fact each
links     each PR, ticket and page it names
callout   one, only for what must not be missed
choices   yes or no: Approve: <verb ...>  Deny: <verb ...>
          or A to E: A. <verb ...>  B. <verb ...>  None of these
          or questions: 2 to 20, each its own A to E, asked one at a time
```

Mermaid is to join the pictures; until then a flow is drawn in ASCII.
A whole patch can ride along as a file: a `.diff` or `.patch` attachment (`git diff > x.diff`) opens in the viewer as a patch view, each changed file side by side, or in one column on a phone.

## It's working if

- You can say what an item asks from its picture and note, and what Approve does, before you read its bullets.
- Every PR, ticket, commit, thread, doc and page a card names opens from the card in one click.
- No drawing on a card shrinks or scrolls sideways.
- An item from any session reads like one from any other.
- Every clock time on a card reads in your own time zone, the `clock.ownerZone` setting, and names it ("9:30 pm UTC").

## Where it fits

Every factory session uses it under [playbook](./playbook.md)'s **ask** rule, which decides when an item goes to the owner; `to-inbox` decides how it reads.
Before it posts, `playground ask open` lists the items already open, so a session names one on the same thing rather than posting it twice.
`playground ask new` checks the shape and prints a hint when the text runs long with no list, code block or attachment, when a line names a PR, a ticket or a commit with no link on it, or when a line in a code block other than a `diff` one runs past the card's width (`ASK_CODE_COLUMNS`), since a `diff` block wraps.
It and `edit` refuse a public post's draft, one with no link, whose words hold a work figure or an internal name, naming the kind and never the words, so what reaches your card is in your own words alone ([playbook](./playbook.md)'s **public** rule).
Once you answer, the session that posted gets your answer as one `[inbox-answer]` line: it does what the line's `next` says, the way its `verb` names, then runs its `close` ([asks.md](../../.agents/dashboard/asks.md)).

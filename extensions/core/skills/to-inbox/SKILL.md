---
name: to-inbox
description: "Write every message the owner reads at a glance, an Inbox item or a reply in chat, Slack or Yard: a picture of the point with a short note (diff, ASCII, before and after shots, an HTML demo), emoji bullets in plain words, one callout, times in the owner's zone. Use before every `playground ask new` and every message to the owner: an ask, a draft, an update, a work status, a relay in chat or a demo."
license: Complete terms in the repository's NOTICE
---

# to-inbox

Every message to the owner is read in seconds, an Inbox card in the aside's narrow column most of all, and the **talk** rule gives each one this skill's shape. This skill makes each message **glanceable**: the owner sees the point first, a picture and its note, then the facts, then what Approve does. The item's shape (its picture and note, its bullets and its options, in that order), its width rule and the `bun run ask` commands live in asks.md's "The ask's shape" ([.agents/dashboard/asks.md](../../../../.agents/dashboard/asks.md)); this skill picks the picture and writes the words.

An `ask` decision renders its text as markdown, with its attachments under it: every step applies. The read-only card, an update carrying an ask's `text` and `attachments`, renders the same with no Approve or Deny: post it for something the owner only looks at (a table, a preview), and it takes every step but 7 and 10. Every other kind shows plain text, exactly as it goes out, so it takes fewer steps, step 1 always first:

- An update with no `text`, or a `ship` or `schema` decision, carries only its fields, which the card lays out itself: its title takes step 5, then steps 8 and 9.
- An `accept`, `apps`, `budget`, `delete`, `grant`, `guard` or `own` decision's `why` is free text, shown as written: it takes steps 3 and 5 as plain lines, one fact each, then steps 8 and 9; a `delete`'s `why` renders as markdown, so it takes step 4 too.
- A `delete` decision's `what` names each target by its full path (`<main checkout>/.claude/worktrees/<name>`), since `playground rm --decision` matches that path and `ask new` refuses a short name.
- A draft, a `slack` decision or a `ticket` decision is the message or ticket itself, so it keeps that text's own shape and takes steps 5, 8 and 9. A draft or a `slack` decision may carry `attachments`, such as an issue's before and after shots, which its card shows under the words and Send leaves out of Slack. A public post's draft, one the owner posts on a social site or a public page, carries `noLink` with the site's name in place of a `link`, and keeps to the **public** rule, which `bun run ask new` holds it to.
- A `secret` ask carries only its key and sink, which the card words itself: its title takes step 5, then step 9; the value itself is the owner's to type into the card, so it appears nowhere in the item.
- A `reveal` card carries only the item's full `service` and a `why`, a plain line: its title takes step 5, then step 9; the card fetches the value on the owner's own click, so it appears nowhere in the item either.

An `ask` or an update about the factory's own work carries `scope: "factory"`, so it can reach the owner on WhatsApp too; an org's work names its org, and a card with no scope stays in the Inbox alone (asks.md, ADR 0024).

Every decision and draft then takes step 10 once the owner answers; an update gets no answer, so it ends at step 9.

A message outside the Inbox, a dispatcher's reply in chat or a Slack or Yard DM, takes steps 2 to 6 and 8, since Choices and Post belong to a card alone; a relay in chat, the dispatcher passing a session's message on to the owner, is one such message, its picture, note and bullets the session's point in the owner's words.
In chat, step 2's picture is a fenced block (an ASCII flow or a diff; a work status block lives in its card, which chat names by its `#iN`), since no-chat-question sends a table, or three or more numbered steps, to one Inbox card instead, unless every row or step names an issue or PR (`scripts/hooks/README.md`).

Pick the kind by how its card closes (asks.md's `settle` and `resolve` lines): you settle a decision or a draft you decided another way, and you resolve your own update once it has settled: an alert that has fixed itself, a progress card whose last step is done.
Until you resolve it or the owner presses Done or Dismiss, an update stays editable, as an ask stays editable, answered or not, until it closes, so a card you will replace (a mock's first version) or a progress you carry takes `playground ask edit` before that.

Beside its choices, every card offers the owner five verbs (asks.md's footer line): ✓ Seen, Later and Archive change only his view, so your item keeps waiting and nothing is typed to you; ✓✓ Done sends an update or an answered card to Done; and Dismiss sends any card to Done, typing you `set-aside` while it still waits, so you hold only its new step, and `dismiss`, drop it, once answered.
On an update, Done types you `done` and Dismiss `dismiss`: post a new card for more, since `ask edit` refuses this one.

## Steps

1. **Already open?** Run `playground ask open` before you write anything (asks.md). Done when no open item asks the same thing, or you have named that item's `#iN` in chat and stopped here.
2. **Picture and note.** Load [plain-words](../plain-words/SKILL.md) with the Skill tool, then pick the one picture asks.md's shape leads with, by its owner style, each line within the card's width ([Fit the card](#fit-the-card)), which a `diff` block is free of, since the card wraps it. Under it, write the picture's note: one sentence on the point. Attachments always show under the text, so an item whose picture is an attachment opens its text on the note, then the bullets. A work status card's block is its picture, and the block's first line, the job and its done/total, is its note ([PROGRESS.md](references/PROGRESS.md)). Done when the text opens on that picture with its note under it, or, when the picture is an attachment, on the note.

   Beside asks.md's diff, ASCII flow and before and after pair, two more fit:

   | The item is about                                    | Its picture                                                                               |
   | ---------------------------------------------------- | ----------------------------------------------------------------------------------------- |
   | A number or a short comparison                       | a markdown table of three columns or fewer                                                |
   | A UI not yet built, or a demo                        | an ASCII sketch of the page; one `html` attachment built by [HTML.md](references/HTML.md) |
   | A code change past a few lines                       | its patch as a file, `git diff > x.diff`, which the viewer draws as a patch view          |
   | A job of several steps (a plan, a lane, a PR series) | the **work status** block, built by [PROGRESS.md](references/PROGRESS.md)                 |

   Mermaid is to render once the Inbox takes it; until then, draw the flow in ASCII.

3. **Bullets.** Write three to five of asks.md's bullets, one fact each, each led by one emoji: the legend's when one fits, else any emoji that names the fact, as asks.md's worked examples do (🧪, 🖼️). Done when no bullet holds two facts.

   | Emoji | Marks                             |
   | ----- | --------------------------------- |
   | 🐛    | the problem                       |
   | ✅    | what is done or tested            |
   | ⚠️    | a risk                            |
   | ↩️    | how to undo it                    |
   | 📨    | who asks, or where it goes        |
   | 🕐    | a clock time, in the owner's zone |
   | ⏱️    | how long it takes                 |
   | 💰    | a cost or a usage figure          |

   A decision that needs more than one answer asks them as a `questions` list the card collects one pick at a time (step 7), where each answer is a choice; or, where the answers are freeform, as numbered questions in the text, the most important first, one idea each, with a one-line why only where a question could be misread.

4. **Links.** Link each PR, ticket, commit, chat thread, doc and page the item names, in markdown, so the owner opens it from the card; an Inbox ref (`#iN`) stays as written, since the owner finds that item in the same Inbox. Done when each one the item names is a link.

   | It names                  | Its link                                                                                                                                                                                    |
   | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | A Playground PR           | `[#N](https://github.com/<factory.repo>/pull/N)`, the repo `playground settings get factory.repo` names                                                                                     |
   | Another repo's PR, commit | `[#N](https://github.com/<owner>/<repo>/pull/N)`, ``[`<sha>`](https://github.com/<owner>/<repo>/commit/<sha>)``                                                                             |
   | A ticket or a chat thread | its page in the org's tracker or chat, in the link form the org's extension gives                                                                                                           |
   | A dashboard page          | in an Inbox card or the dashboard's chat, its path alone, `[System page](/dashboard/system)`, which opens on the dashboard's own host; in a Slack or Yard message, the page's name in words |
   | A file in a repo          | its GitHub page at a commit, `https://github.com/<owner>/<repo>/blob/<sha>/<path>`                                                                                                          |

5. **Plain words.** Load [plain-words](../plain-words/SKILL.md) with the Skill tool, when step 2 has not, and write every sentence by its two rules. Done when each sentence passes them, and these two house rules too:
   - It speaks in the first person singular, "I", never "we" or the session's name: the poster's "I" in an ask, the owner's in a draft or a `slack` decision, which goes out in his voice (asks.md).
   - A time reads in the owner's zone (`clock.ownerZone`, which `playground rules clock` prints), am/pm, named by that zone ("9:30 pm UTC"); a now-time is `{now}`, which `bun run ask` fills with the time it posts at.

6. **Callout.** When one fact must not be missed, put it in one GitHub callout after the bullets. Done when the item holds one callout or none.

   | Callout          | For                                       |
   | ---------------- | ----------------------------------------- |
   | `> [!CAUTION]`   | a step that cannot be undone              |
   | `> [!WARNING]`   | a risk that can be undone                 |
   | `> [!IMPORTANT]` | the one thing the owner must do or decide |
   | `> [!NOTE]`      | context the choice depends on             |
   | `> [!TIP]`       | a faster way the owner may like           |

7. **Choices.** Pick the shape, then label each option in the same plain words (asks.md's `options` and `deny`). A true yes or no takes one `options` row, what Approve does, and `deny`, what Deny means; a choice between real alternatives takes 2 to 5 rows, lettered A to E on the card, each a `label` and an optional `description`, with None of these after them. For several independent calls at once, a `questions` list in place of `options`: 2 to 20 questions, each its own 1 to 5 labelled options and an optional `recommended` index, which the card asks one at a time and sends together. Done when the shape fits the question and each label starts with a verb.

8. **Fake data.** Read the text and every attachment once more. Done when no part holds a token, a customer detail or a real database row, a demo's or screenshot's names and rows are made up, and a public post's draft (the `noLink` draft above) keeps to the **public** rule.

9. **Post.** Post it with `playground ask new`, which runs `bun run ask new` in the Dashboard's checkout from any worktree, as asks.md says, and read stderr. Done when `playground ask` prints the item's id and no shape hint; on a hint, the item has already posted, so fix what the hint names and replace it in place with `playground ask edit <id> < item.json`, until edit prints no hint.

10. **Answer.** The owner's answer comes back as one line, `[inbox-answer] {json}` (asks.md): do what its `next` says, the way its `verb` names, then run its `close`. The line names its item by `ref` and carries none of its text, so when you no longer hold what you asked, as after a compaction, read the item with `playground ask get <ref>` first. A `send` sends the message (its `text` when he changed it), a `draft` saves it with `slack_send_message_draft` and leaves it unsent, and a `pick` carrying `opened` rechecks the grant; a step the dashboard ran (`accepted`, `listed`, `opened`, `set`) whose `exitCode` is not 0 takes the follow-up asks.md names for it before the close. A reply in his own words (`re #iN: <words>`, from the card's Reply or his chat) asks for changes to the item: make them with `playground ask edit <id>`, which puts the card back before him marked Updated, or carry it out and close it with `playground ask ack <ref>`. Done when `playground ask get <id>` shows the item closed, or edited for his reply.

## Fit the card

Draw each code or ASCII line up to `ASK_CODE_COLUMNS` (`packages/config/src/inbox.ts`), 37 columns, an emoji counted as two.
The card shows a drawing at its 12px code size, and shrinks a wider one's font to fit, down to 10px, before it scrolls sideways, so a line of that width shows whole at 12px on the narrowest card.
A picture that runs past it becomes a table of three columns or fewer, or bullets.

## Example

An `ask` decision's text, as its card shows it to an owner whose `clock.ownerZone` is UTC, the setting's default:

````markdown
```
canary ──▶ main
   │
   ▼
Ops ships 3 PRs
```

Ops ships 3 PRs to main at 10:00 pm UTC.

- ✅ Checks pass on all 3 PRs.
- ⚠️ One PR changes the spawn gate.
- ↩️ One revert undoes the ship.
- 🕐 I start at 10:00 pm UTC.

> [!IMPORTANT]
> I need your yes before 10:00 pm UTC.
````

Options: `Ship canary to main at 10:00 pm UTC`; Deny: `Hold the ship until tomorrow`.

## Keep the skills learning

When an item reads badly despite these steps, or you find a format the card renders that this skill does not name, tell the `dispatcher` session: `SendMessage` to `dispatcher` with what happened, what worked, and which step it belongs in, in a few plain lines. That session turns findings into a reviewed change to the factory's repo. When `ListAgents` lists no `dispatcher` session, end your report with the finding instead, so the owner can pass it on. A finding never carries prod data, secrets or customer details.

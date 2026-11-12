import { afterAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  asksDecision,
  check,
  type Deps,
  DASHBOARD_DEADLINE_MS,
  readStatus,
  LEAD_REASON,
  REASON,
  STEPS_REASON,
} from "../../../scripts/hooks/no-chat-question"
import { capital, OLD, OLD_NAMES } from "../../session-names"
import { ITEMS } from "./inbox-items"
import { storeWith } from "./render-set"

const script = join(import.meta.dir, "..", "..", "..", "scripts", "hooks", "no-chat-question.ts")
// A lead's old name as the hook's own agent pattern spells it (agentOf), built at run time; a stand-in from sessions.aliases is not one the pattern knows.
const LEAD = ["light", "kid"].join("")

// A config folder whose roster holds a builder under a new name, so no case reads this machine's roster.
const config = mkdtempSync(join(tmpdir(), "no-chat-question-"))
// A made-up owner's first name and handle, as owner.names would set them.
const OWNER = ["quilla", "qmarsh"]
afterAll(() => rmSync(config, { force: true, recursive: true }))
mkdirSync(join(config, "playground"))
storeWith(join(config, "playground"), {}, { "sessions.aliases": OLD_NAMES })
writeFileSync(
  join(config, "playground", "roster.json"),
  JSON.stringify({
    agents: [
      { kind: "builder", name: "x7mh4d-builder", role: "manager", status: "working", task: "t" },
      { kind: "dispatcher", name: "seat-k8w2rd", role: "manager", status: "working", task: "t" },
      { kind: "worker", name: "k3v9q2-worker", role: "worker", status: "working", task: "t" },
      { name: "k3m9px-worker", role: "worker", status: "working", task: "t" },
      { name: "worker-plain-fern", role: "worker", status: "working", task: "t" },
      { name: "optimizer", role: "manager", status: "working", task: "t" },
      { name: "probe-dashboard", role: "worker", status: "ended", task: "t" },
    ],
  }),
)

const input = (last: unknown, active = false) =>
  JSON.stringify({
    hook_event_name: "Stop",
    last_assistant_message: last,
    session_id: "s-1",
    stop_hook_active: active,
    transcript_path: "/nonexistent/transcript.jsonl",
  })

// bun run ask faked: each #iN's status, or an error for one it cannot read
const fakeDashboard =
  (statuses: Record<string, string | Error> = {}): Deps["itemStatus"] =>
  async (ref) => {
    const status = statuses[ref]
    if (status instanceof Error) throw status
    if (status === undefined) throw new Error(`no inbox item ${ref}`)
    return status
  }

const stop = (
  last: unknown,
  {
    active = false,
    name,
    role = "dispatcher",
    statuses,
  }: {
    active?: boolean
    name?: string
    role?: string
    statuses?: Record<string, string | Error>
  } = {},
) =>
  check(
    input(last, active),
    {
      CLAUDE_CONFIG_DIR: config,
      PLAYGROUND_DATA_DIR: join(config, "playground"),
      PLAYGROUND_ROLE: role,
    },
    { itemStatus: fakeDashboard(statuses), ownerNames: async () => OWNER, sessionName: () => name },
  )

describe("a manager's reply that asks Quilla a decision is refused until it is in the inbox", () => {
  test.each([
    ["tonight's miss: can we", "Can we apply the SQL to dev ourselves?"],
    ["tonight's miss: say yes", "Say yes, or that you'd rather we just fix it"],
    ["tonight's miss: if you still want", "If you still want it, I'll post it"],
    ["tonight's miss: shall I", "Shall I have someone find the owner?"],
    ["tonight's miss: say a quoted word", 'Say "ship now" if you want it out tonight'],
    ["tonight's miss: curly quotes", "Say “ship now” if you want it out tonight"],
    ["tonight's miss: a question mark", "Should it get its own ticket?"],
    ["tonight's miss: your call", "Whether to allow a second runner is still your call"],
    ["a question mid-reply", "Should it get its own ticket? The fix is in #500 either way."],
    ["a question behind closing marks", "Ship it (canary 3f9a2c1)?**"],
    ["a question over its options", "Which do you want first?\n1. #474\n2. #472"],
    ["say go", "Say go and it ships."],
    ["want me to", "Want me to close the probe."],
    ["do you want", "Do you want the screenshots as well"],
    ["if you'd rather, curly apostrophe", "I'll merge it, if you’d rather not wait."],
    ["tell me if", "Tell me if that should wait."],
    ["one word answer", "A one-word answer is enough."],
    ["settles it", "Your yes settles it."],
    ["is yours to", "The ship is yours to make."],
    ["if you want", "I can post it if you want."],
    ["any case", "SHOULD I ship it."],
    ["an ask under a list", "Done:\n- merged #472\n\nShould I ship it."],
    ["a question addressed to Quilla by @", "@Quilla, should I ship it?"],
    ["a question addressed to his handle", "@qmarsh: can we merge it?"],
    ["an ask after a colleague's words", `${capital(LEAD)} said it's ready: should I ship it.`],
    ["an ask after a colleague's sentence", `${capital(LEAD)} says: it's ready. Should I ship it?`],
    ["an ask after a line to an agent", `- ${LEAD}: done. Should I ship it?`],
    ["a hyphened word that names no session (PG-1644)", "well-known, should I ship it?"],
    ["a six-letter word that names no session (PG-1644)", "Rhythm: should I ship it?"],
    [
      "a role label opening a question to the owner (PG-1644)",
      "Ops: should I restart the dashboard?",
    ],
    [
      "a role label, comma, opening a question to the owner (PG-1644)",
      "Builder, should I hold the train?",
    ],
    [
      "a roster name that reads as a role label (PG-1644)",
      "Optimizer: should I restart the dashboard?",
    ],
    ["an ended row's name as chat shows it (PG-1644)", "Dashboard: should I restart it?"],
    [
      "an ask to Quilla after one to an agent",
      `${capital(LEAD)}, ship #500. Quilla, should I also delete the table?`,
    ],
    ["an ask after what was sent to an agent", `Sent ${LEAD}: the plan. Can we merge it tonight?`],
    ["a markdown heading over facts", "## Why did CI fail?\n- the lock was held\n- it is free now"],
    ["a bold heading over a line", "**1. Start the four Labs-port tickets now?**\nThey are ready."],
    ["say a quoted phrase", 'Say "ship now" and it goes out tonight.'],
    ["say a quoted word", 'Say "hold" to keep it for tomorrow.'],
    ["a question with a bang", "Ship it?!"],
    ["should we", "Should we hold the train until morning."],
    ["let me know which", "Let me know which one goes first."],
    ["your pick", "Your pick: Brave Otter or Calm Heron."],
    ["a status bullet with a comma-joined ask", `- ${LEAD}: idle, want me to start lane B?`],
    ["a worker's status bullet with an ask", "- worker-x: blocked, should it wait?"],
    ["a numbered status bullet with an ask", `1. ${LEAD}: idle, want me to start lane B?`],
    ["say a backticked word", "Say `go` to ship it."],
    ["an ask after a semicolon to an agent", `${LEAD}: done; should I ship?`],
    ["an ask to Quilla after a semicolon", `${LEAD}, hold the train; Quilla, should I ship?`],
    ["a question mark before a comma", "Ship it?, or wait"],
    ["its own ask, one", "One ask: should I ship it?"],
    ["its own ask, my", "My ask: can we merge tonight?"],
    ["its own ask, quick", "Quick ask: do you want the dump first?"],
    ["its own ask, I ask", "I ask: should I ship it?"],
    ["its own words, I said", "I said: should I ship it?"],
    ["say a single-quoted yes", "Say 'yes' and it ships."],
    ["say a curly single-quoted go", "Say ‘go’ and it ships."],
    ["if you want, then an offer", "If you want, I can merge it now."],
    ["an ask after an optional pointer", "The shots are on #1865 if you want to look. Ship it?"],
    ["say go after an optional pointer", "If you want to see it, say go and I'll start a stack."],
    ["say a quoted go (#2023)", 'Say "go"'],
    ["just say yes", "just say yes"],
    ["say go in a bullet", "- Say go and it ships."],
    ["you'd say a backticked word", "Once it's green you'd say `go`."],
    ["then say a backticked word", "Then say `go`."],
    ["so say go", "So say go when ready."],
    ["simply say yes", "Simply say yes and it ships."],
    ["you can, then an ask", "You can merge it now, or should I wait?"],
    ["you can say yes", "You can say yes and it ships."],
    ["you can tell me if", "You can tell me if it should ship."],
    ["you can, then please", "You can open #1865 and please approve it"],
    ["you can say go", "You can reply here or say go"],
    ["tell me if, then a pointer", "Tell me if you want to see it."],
    ["tell me if, then look", "Tell me if you want to look at it"],
    ["tell me if, still", "Tell me if you still want to check it."],
    ["let me know if, then look", "Let me know if you want to look."],
    ["say if, then a pointer", "Just say if you want to see it."],
    ["let me know, words, then if", "Let me know here if you want to look."],
    ["tell me, words, then if", "Tell me in chat if you want to see it."],
    ["tell me quickly, then if", "Tell me quickly if you want to check it."],
    ["tell us if", "Tell us if you want to look."],
    ["need to know if", "I need to know if you want to look."],
    ["say, words, then if", "Just say here if you want to see it."],
  ])("%s", async (_name, last) => {
    expect(await stop(last)).toBe(REASON)
  })

  test.each([
    ["13 Oct's miss: you need to", "You need to plug in the Mac so the runner can wake."],
    ["you have to", "You have to paste the token into 1Password first."],
    ["you'll need to, curly apostrophe", "You’ll need to add the API keys before it runs."],
    ["you will need to", "You will need to log in again."],
    ["you must", "You must approve the OAuth app."],
    ["only you can", "Only you can switch the GitHub plan."],
    ["could you", "Could you restart cmux when free."],
    ["please", "Please paste the token into the file."],
    ["when you can", "Add the key when you can."],
    ["when you get a chance", "Log in to Loom when you get a chance."],
    ["is waiting on you", "The ship is waiting on you."],
    ["<verb> it yourself", "Run it yourself from the main checkout."],
    ["a bare imperative addressed to Quilla", "Quilla, plug in the Mac."],
    ["a bare imperative addressed to @Quilla", "@Quilla: paste the token in 1Password."],
    ["a bare imperative addressed to his handle", "- @qmarsh, approve the OAuth app."],
    ["an action after a line to an agent", `${LEAD}: done. You need to log in again.`],
    ["a verb ending in s addressed to Quilla", "Quilla, press Approve on the card."],
    ["pass addressed to Quilla", `Quilla, pass the key to ${LEAD}.`],
    ["please at the end", "Reload the tab, please."],
    ["a need under don't, which still asks", "Don't you need to log in."],
    ["it yourself, not right after you can", "You can now withdraw it yourself."],
    ["when you can, then a verb", "When you can approve the OAuth app."],
    ["it yourself after you can, then please", "You can run it yourself, please do it today."],
  ])("a request for his action: %s", async (_name, last) => {
    expect(await stop(last)).toBe(REASON)
  })

  test("the reason sends the session to an open item on the same thing before a new one", () => {
    expect(REASON).toBe(
      "name the open #iN on the same thing if one exists (playground ask open lists them), else post it with playground ask new, then say in chat that it's in the inbox as #iN",
    )
    expect(REASON.indexOf("playground ask open")).toBeLessThan(REASON.indexOf("playground ask new"))
  })

  // cmux restores a session without PLAYGROUND_ROLE, so a manager is also known by its session name or roster kind, as role.ts reads them.
  test("the dispatcher keeps its line by role, by its session name and as the second dispatcher, and so does a manager by role", async () => {
    expect(await stop("Merge them now?", { role: "dispatcher" })).toBe(REASON)
    expect(await stop("Merge them now?", { role: "manager" })).toBe(REASON)
    for (const name of [OLD.dispatcher, `${OLD.dispatcher}-2`])
      expect(await stop("Merge them now?", { name, role: "" })).toBe(REASON)
  })

  test("a lead is sent to the dispatcher by role, by its session name and by its roster kind", async () => {
    expect(await stop("Merge them now?", { role: "lead" })).toBe(LEAD_REASON)
    for (const name of [OLD.builder, OLD.ops, OLD.planner, "optimizer", "x7mh4d-builder"])
      expect(await stop("Merge them now?", { name, role: "" })).toBe(LEAD_REASON)
  })

  test("the lead's reason sends the decision to the dispatcher by SendMessage and keeps it out of chat", () => {
    expect(LEAD_REASON).toBe(
      "send the decision to the dispatcher with SendMessage, which posts it to the Inbox, and keep the question out of chat; once the dispatcher names its #iN, say in chat that it's in the inbox as #iN",
    )
  })

  test("a lead naming a closed item is refused with the lead's line, saying the item is not open", async () => {
    const reason = await stop("It's in the inbox as #i40. Ship now?", {
      role: "lead",
      statuses: { "#i40": "approved" },
    })
    expect(reason).toStartWith(LEAD_REASON)
    expect(reason).toContain("#i40 is approved")
  })

  test("a second stop in the same turn is refused too, so the ask cannot stand", async () => {
    expect(await stop("Merge them now?", { active: true })).toBe(REASON)
  })

  test("a reply naming a closed item is refused, saying the item is not open", async () => {
    const reason = await stop("It's in the inbox as #i40. Ship now?", {
      statuses: { "#i40": "approved" },
    })
    expect(reason).toStartWith(REASON)
    expect(reason).toContain("#i40 is approved")
  })

  test("a reply naming an item bun run ask cannot read fails closed with why", async () => {
    const reason = await stop("It's in the inbox as #i41. Ship now?", {
      statuses: { "#i41": new Error("bun run ask timed out after 5s") },
    })
    expect(reason).toStartWith(REASON)
    expect(reason).toContain("#i41 could not be read")
    expect(reason).toContain("bun run ask timed out after 5s")
  })
})

describe("what passes", () => {
  test.each([
    ["a status report", "Both PRs merged. The dashboard runs canary 3f9a2c1."],
    ["a quoted question from a colleague", "Avery asks: “Can we ship the export fix tonight?”"],
    ["a quoted question with straight quotes", 'Niven said: "should I take MADEDUNE-2186?"'],
    ["a question that says where it was asked", "Avery asks in Slack: can we merge?"],
    ["a blockquoted question", "From the thread:\n> Can we apply it to dev?"],
    ["a question to another agent", `@${capital(LEAD)}, can we take #500 next?`],
    ["a question to a lead by name", `${LEAD}: should I hold the train?`],
    ["a question to a lead by name, comma", `${LEAD}, should I hold the train?`],
    ["a question sent to an agent", `Sent ${LEAD}: can we take #500 next?`],
    ["a bold colleague's label", "**Avery asks:** can we ship tonight?"],
    ["a bold agent's label", `**${LEAD}:** can we take #500?`],
    ["a question to an agent with to", `To ${LEAD}: should it wait for canary?`],
    ["a question I asked an agent", `I asked ${LEAD}: should it wait for canary?`],
    ["a sentence to an agent with a dot inside", `Sent ${LEAD}: bump to v1.2, then merge?`],
    ["a question asked of a worker", "Asked worker-brave-otter: should it wait for canary?"],
    ["a question asked of an id-named worker", "Asked k3m9px-worker: should it wait for canary?"],
    ["a question to an id-named reviewer by name", "k3m9px-reviewer, is the test red?"],
    [
      "a question put to a worker as chat names it (PG-1644)",
      "Asked plain-fern: should it wait for canary?",
    ],
    ["a question to an id-named worker as chat names it (PG-1644)", "k3m9px, is the test red?"],
    ["a quoted say yes", 'The gate now refuses "say yes".'],
    ["a PR that will say a backticked ref (#2023)", "The PR will say `Refs #1`"],
    [
      "a PR that will say a backticked ref, so the issue stays open",
      "The PR will say `Refs #1212`, so the issue stays open.",
    ],
    ["a bot that will say a quoted word", 'The bot will say "done" once it merges.'],
    ["a backticked span with a ? that a third person will say", "The hook will say `why?` here."],
    ["a bot that will say a word after then", "Checks run, then the bot will say `PASS`."],
    ["a question inside a code block", "Run this:\n\n```bash\nread -p 'ok?' a\n```"],
    ["a question in inline code", "The hook matches `should I?`"],
    ["a URL with a query", "The board is at https://playground.localhost/x?status=todo now."],
  ])("%s", async (_name, last) => {
    expect(await stop(last)).toBeUndefined()
  })

  test.each([
    ["a numbered agent plan", "1. Paste the shot on the PR.\n2. Switch the flag."],
    ["a heading with a bare verb", "## Approve flow\n- the card shows Approve and Deny"],
    ["waiting on your inbox", `${capital(LEAD)} · Waiting on your inbox`],
    ["past tense: you approved", "You approved #i41, so it shipped."],
    ["past tense: you asked", "You asked for the totals; they are below."],
    ["a backticked command", "The runner logs `please wait` while it builds."],
    ["please to another agent", `${LEAD}, please rebase #500.`],
    ["please inside a quote", 'Avery said: "please merge it tonight."'],
    ["an -ed verb before it yourself", "You fixed it yourself last night."],
    ["a status addressed to Quilla", "Quilla, both PRs merged."],
    ["an update addressed to Quilla", "@Quilla: your PR is ready in the inbox as an update."],
    ["please inside a channel's name", "I posted your EOB to #projects-status-eob-please."],
    ["nothing waiting on him", "Nothing is waiting on you now."],
    ["nothing he needs to do", "Nothing you need to do here."],
    ["a need under if", "If you need to roll back, run the old build."],
    ["a need under anything", "Anything you need to decide reaches you through your Inbox."],
    ["a heading saying what he needs to know", "## What you need to know\n- both merged"],
    ["a page only he can see", "It is a private page only you can see."],
    ["when you can't", "It fails when you can't reach cmux."],
    ["only you can't", "Only you can't reach it from here."],
    ["did it yourself", "You did it yourself last night."],
    ["ran it yourself", "You ran it yourself from main."],
    ["a label line to Quilla", "- Quilla: frontend, with 436 commits."],
    ["a quick update to Quilla", "Quilla, quick update: canary is green."],
    ["good news to Quilla", "Quilla, good news: both merged."],
    // 23 Oct's misfires: an optional pointer leaves him free to skip it.
    ["an optional pointer: if you want to look", "The shots are on #1865 if you want to look."],
    [
      "an optional pointer: it yourself, if you want",
      "You can withdraw it yourself with npm deprecate if you want.",
    ],
    [
      "an optional pointer: if you want to see it",
      "It is a quick screenshot job if you want to see it.",
    ],
    ["it yourself right after you can", "You can withdraw it yourself."],
  ])("not a request for his action: %s", async (_name, last) => {
    expect(await stop(last)).toBeUndefined()
  })

  test("a line to the owner by name asks only for the names owner.names sets, so with none set it is an agent's", async () => {
    const unset = (last: string) =>
      check(
        input(last),
        {
          CLAUDE_CONFIG_DIR: config,
          PLAYGROUND_DATA_DIR: join(config, "playground"),
          PLAYGROUND_ROLE: "lead",
        },
        { itemStatus: fakeDashboard({}), ownerNames: async () => [], sessionName: () => "x" },
      )
    expect(await unset("Quilla, plug in the Mac.")).toBeUndefined()
    expect(await unset("@qmarsh, should I ship it?")).toBeUndefined()
    expect(await stop("Quilla, plug in the Mac.")).toBe(REASON)
  })

  test("a request for his action naming an open item", async () => {
    expect(
      await stop("You need to plug in the Mac: it's in the inbox as #i42.", {
        statuses: { "#i42": "open" },
      }),
    ).toBeUndefined()
  })

  test("a reply naming an open item", async () => {
    expect(
      await stop("It's in the inbox as #i41: ship canary 3f9a2c1 tonight?", {
        statuses: { "#i41": "open" },
      }),
    ).toBeUndefined()
  })

  // a progress card counts for steps alone, so it never stands in for the decision a chat ask puts to the owner (#1486)
  test("a decision asked beside a progress card is refused, since the card is listed, not open", async () => {
    expect(
      await stop("Should I merge PR 12 now? Progress is in #i42.", {
        statuses: { "#i42": "listed" },
      }),
    ).toBe(`${REASON} (#i42 is listed, not open or archived while open)`)
    expect(
      await stop(
        `Should I merge PR 12 now?\n1. Rotate the key.\n2. Restart the API.\n3. Check /api/health.\nProgress is in #i42.`,
        {
          statuses: { "#i42": "listed" },
        },
      ),
    ).toBe(`${REASON} (#i42 is listed, not open or archived while open)`)
  })

  // a table row answers its own cell's question, so its ? is no ask; a row's other words still are; on 7 Nov two such rows beside a progress card each brought a copy of the card (#1486)
  test("a question in a markdown table row is no ask, while a plain question line and a row's ask phrase still are", () => {
    expect(asksDecision("| Check | Result |\n|---|---|\n| Did it still answer then? | yes |")).toBe(
      false,
    )
    expect(asksDecision("Did it still answer then?")).toBe(true)
    expect(asksDecision("| Step | Who |\n|---|---|\n| Merge now? | your call |")).toBe(true)
  })

  test.each([
    ["a header row with a ? column", "| PR | Merged? |\n|---|---|\n| 1493 | yes |", false],
    [
      "a row whose last cell asks",
      "| PR | Score | Next |\n|---|---|---|\n| 1493 | 3/5 | Merge after the fix? |",
      true,
    ],
    ["a one-cell row", "| Merge PR 12 now? |", true],
    [
      "a row whose answer cell is empty",
      "| Check | Result |\n|---|---|\n| Ship it today? |  |",
      true,
    ],
    ["a line opening with a pipe and no closing one", "| Ship it today?", true],
  ])("a table's ? asks only when no cell after it answers it: %s", (_name, reply, asks) => {
    expect(asksDecision(reply)).toBe(asks)
  })

  test("a table of answered questions naming a progress card passes", async () => {
    expect(
      await stop(
        "| Check | Result |\n|---|---|\n| Did it still answer then? | yes |\n\nProgress is in #i42.",
        {
          statuses: { "#i42": "listed" },
        },
      ),
    ).toBeUndefined()
  })

  // an open decision the owner archived still waits on the owner, so an ask naming it passes, as it did before the listed rule (#1486)
  test("a decision asked again beside an open decision the owner archived passes", async () => {
    expect(
      await stop("It's in the inbox as #i41: ship canary 3f9a2c1 tonight?", {
        statuses: { "#i41": "archived while open" },
      }),
    ).toBeUndefined()
  })

  test("a reply naming a closed item and an open one", async () => {
    expect(
      await stop("#i40 is done. The next call is #i41: should it wait?", {
        statuses: { "#i40": "approved", "#i41": "open" },
      }),
    ).toBeUndefined()
  })

  test("a worker, reviewer, tester, runner or probe, whose replies go to a lead", async () => {
    for (const role of ["worker", "reviewer", "tester", "runner", "probe"])
      expect(await stop("Merge them now?", { name: "worker-brave-otter", role })).toBeUndefined()
  })

  test("a session with no role and no manager's name", async () => {
    expect(await stop("Merge them now?", { role: "" })).toBeUndefined()
    expect(await stop("Merge them now?", { name: "scratch", role: "" })).toBeUndefined()
    expect(await stop("Merge them now?", { name: "k3v9q2-worker", role: "" })).toBeUndefined()
  })

  test("an input it cannot read fails open", async () => {
    expect(await stop(undefined)).toBeUndefined()
    expect(await stop(42)).toBeUndefined()
    expect(await check("not json", { PLAYGROUND_ROLE: "dispatcher" })).toBeUndefined()
  })
})

describe("a manager's reply that keeps steps or a table for Quilla goes in one Inbox card", () => {
  const STEPS = "Next:\n1. Rotate the key.\n2. Restart the API.\n3. Check /api/health."
  const TABLE = "| Step | State |\n|---|---|\n| Rotate the key | done |"

  test.each([
    ["3 numbered steps", STEPS],
    ["3 steps numbered with a paren", "1) Pull canary\n2) Build it\n3) Restart it"],
    ["a table", TABLE],
    [
      "a table with aligned columns",
      "| Step | State |\n| :--- | ---: |\n| Rotate the key | done |",
    ],
  ])("refused with no #iN: %s", async (_name, last) => {
    expect(await stop(last)).toBe(STEPS_REASON)
  })

  test("the reason sends the steps to one card whose progress is edited in place", () => {
    expect(STEPS_REASON).toBe(
      "put these steps in one Inbox card (playground ask new; the open #iN on the same thing if one exists, playground ask open lists them), edit each step's progress into that card, then name it in chat as #iN in one line",
    )
  })

  test("a reply that also asks a decision gets the ask's reason", async () => {
    expect(await stop(`${STEPS}\nShould I start?`)).toBe(REASON)
  })

  test("a named item that is not open fails closed with why", async () => {
    expect(await stop(`${STEPS}\nTracked in #i40.`, { statuses: { "#i40": "approved" } })).toBe(
      `${STEPS_REASON} (#i40 is approved, not open or listed)`,
    )
  })

  test.each([
    ["2 numbered lines", "1. Rotated the key.\n2. Restarted the API."],
    ["numbered lines inside a fence", "Ran:\n```\n1. pull\n2. build\n3. restart\n```"],
    ["numbered lines in a blockquote", "> 1. pull\n> 2. build\n> 3. restart"],
    ["a table inside a fence", "```\n| PR | State |\n|---|---|\n```"],
    ["a bulleted list", "- Rotated the key.\n- Restarted the API.\n- Health reads ok."],
  ])("passed: %s", async (_name, last) => {
    expect(await stop(last)).toBeUndefined()
  })

  test("passed: 3 numbered steps that name an open #iN", async () => {
    expect(
      await stop(`${STEPS}\nIt's in the inbox as #i42.`, { statuses: { "#i42": "open" } }),
    ).toBeUndefined()
  })

  // an update is stored done from the moment it is posted while the Inbox still lists it, so a gate that took open alone asked for a copy of the card on every progress edit (#1486)
  test("passed: 3 numbered steps that name a progress card the Inbox lists", async () => {
    expect(
      await stop(`${STEPS}\nProgress is in #i42.`, { statuses: { "#i42": "listed" } }),
    ).toBeUndefined()
  })

  test.each(["archived", "archived while open", "denied", "dismissed", "done", "settled"])(
    "refused: 3 numbered steps whose only card is %s",
    async (standing) => {
      expect(await stop(`${STEPS}\nProgress is in #i42.`, { statuses: { "#i42": standing } })).toBe(
        `${STEPS_REASON} (#i42 is ${standing}, not open or listed)`,
      )
    },
  )

  // a lead's or another manager's reply in its pane is its report to its manager, which folds its lines into the owner's one card, so steps or a table there are no card of their own (#1522)
  test.each([
    [
      "a report table whose rows name no issue",
      "| Run | Result |\n|---|---|\n| canary | 3 refused |\n| branch | 0 refused |",
    ],
    [
      "a 3-item numbered report",
      "Done:\n1. Rebased onto canary.\n2. Fixed the stale doc line.\n3. Ran the touched tests: 12 pass.",
    ],
    [
      "a 5-item list of what a self-review fixed",
      "The self-review fixed:\n1. A stale doc line.\n2. A missing test case.\n3. A typo in the reason.\n4. The README's order.\n5. A wrapped sentence.",
    ],
    [
      "a table of two commands with their results",
      "| Command | Result |\n|---|---|\n| `bun run test:file a.test.ts` | 12 pass, 0 fail |\n| `bun run check-types` | clean |",
    ],
  ])("passed: a lead's report, %s", async (_name, last) => {
    expect(await stop(last, { role: "lead" })).toBeUndefined()
    expect(await stop(last, { role: "manager" })).toBeUndefined()
    expect(await stop(last, { name: "x7mh4d-builder", role: "" })).toBeUndefined()
  })

  test("a lead's steps pass, while the dispatcher's own steps still refuse", async () => {
    expect(await stop(STEPS, { role: "lead" })).toBeUndefined()
    expect(await stop(STEPS, { role: "dispatcher" })).toBe(STEPS_REASON)
  })

  test("the dispatcher's own steps keep the Inbox reason, a draft line included", async () => {
    expect(await stop(STEPS, { name: "dispatcher", role: "" })).toBe(STEPS_REASON)
    expect(await stop(STEPS, { name: "seat-k8w2rd", role: "" })).toBe(STEPS_REASON)
    expect(await stop(`${STEPS}\nSent these steps to the dispatcher as a draft.`)).toBe(
      STEPS_REASON,
    )
  })

  test("a lead's steps pass, never a decision it asks", async () => {
    expect(
      await stop(`${STEPS}\nSent these steps to the dispatcher as a draft. Should I start?`, {
        role: "lead",
      }),
    ).toBe(LEAD_REASON)
  })

  // progress on work tracked elsewhere stays in chat, since the Inbox holds decisions and alerts: every numbered line or table body row names an issue or PR
  test.each([
    [
      "3 numbered lines that each name a #<n>",
      "Merge order:\n1. #1089 merged at c88ae1b8\n2. #1094 in review\n3. #1095 next",
    ],
    [
      "3 numbered lines that each link an issue or PR",
      "1. https://github.com/acme/app/pull/12 merged\n2. https://github.com/acme/app/issues/13 open\n3. https://github.com/acme/app/pull/14 in review",
    ],
    [
      "a table whose every body row names a #<n>",
      "| PR | ETA |\n|---|---|\n| #1089 | merged |\n| #1094 | 03:40Z |",
    ],
  ])("passed: progress on tracked work, %s", async (_name, last) => {
    expect(await stop(last)).toBeUndefined()
    expect(await stop(last, { role: "lead" })).toBeUndefined()
  })

  test.each([
    [
      "3 numbered lines, one naming no #<n>",
      "1. #1089 merged\n2. #1094 in review\n3. Restart the API.",
    ],
    [
      "3 numbered lines naming only Inbox items",
      "1. #i40 drafted\n2. #i41 drafted\n3. #i42 drafted",
    ],
    [
      "a table with one body row naming no #<n>",
      "| PR | ETA |\n|---|---|\n| #1089 | merged |\n| Restart the API | next |",
    ],
    ["a table with no body rows", "| PR | ETA |\n|---|---|"],
  ])("refused: steps that are not all tracked work, %s", async (_name, last) => {
    const statuses = { "#i40": "approved", "#i41": "approved", "#i42": "approved" }
    expect(await stop(last, { statuses })).toStartWith(STEPS_REASON)
    expect(await stop(last, { role: "lead", statuses })).toBeUndefined()
  })

  test("passed: a worker's steps, which go to its lead", async () => {
    expect(await stop(STEPS, { name: "worker-brave-otter", role: "worker" })).toBeUndefined()
  })
})

test("run as Claude Code runs it, a decision ask continues the turn with the reason as context", async () => {
  const run = Bun.spawn(["bun", "--no-env-file", script], {
    env: { ...process.env, PLAYGROUND_ROLE: "lead" },
    stdin: new Blob([input("Merge them now?")]),
    stdout: "pipe",
  })
  expect(await run.exited).toBe(0)
  const output = JSON.parse(await new Response(run.stdout).text())
  expect(output.hookSpecificOutput.hookEventName).toBe("Stop")
  expect(output.hookSpecificOutput.additionalContext).toBe(LEAD_REASON)
})

test("run as Claude Code runs it, a report stops with no output", async () => {
  const run = Bun.spawn(["bun", "--no-env-file", script], {
    env: { ...process.env, PLAYGROUND_ROLE: "lead" },
    stdin: new Blob([input("Both PRs merged.")]),
    stdout: "pipe",
  })
  expect(await run.exited).toBe(0)
  expect(await new Response(run.stdout).text()).toBe("")
})

describe("the dashboard read's time limits (#1269)", () => {
  // A checkout whose bun run ask writes its pid beside it, then answers each ref after its delay, as the live dashboard's does under load.
  const stubDashboard = (delays: Record<string, number>, item: object = { status: "open" }) => {
    const dir = mkdtempSync(join(tmpdir(), "no-chat-question-dashboard-"))
    mkdirSync(join(dir, "api", "hono", "src", "bin"), { recursive: true })
    writeFileSync(
      join(dir, "api", "hono", "src", "bin", "dashboard-ask.ts"),
      `const ref = process.argv[3]\nawait Bun.write(\`\${import.meta.dir}/\${ref.slice(1)}.pid\`, String(process.pid))\nawait Bun.sleep(${JSON.stringify(delays)}[ref] ?? 0)\nconsole.log(JSON.stringify(${JSON.stringify(item)}))\n`,
    )
    return dir
  }
  const stubs: string[] = []
  afterAll(() => {
    for (const dir of stubs) rmSync(dir, { force: true, recursive: true })
  })
  const asDispatcher = (last: string, itemStatus: Deps["itemStatus"]) =>
    check(
      input(last),
      {
        CLAUDE_CONFIG_DIR: config,
        PLAYGROUND_DATA_DIR: join(config, "playground"),
        PLAYGROUND_ROLE: "dispatcher",
      },
      { itemStatus, sessionName: () => undefined },
    )

  // bun run ask get prints the whole item: an update is stored done from its post on, so whether the Inbox lists it, and what was done with it, is read from its answer and readAt (#1486)
  test.each(ITEMS.filter((c) => c.standing))(
    "$name reads $standing",
    async ({ item, standing }) => {
      const dashboard = stubDashboard({}, item)
      stubs.push(dashboard)
      expect(await readStatus("#i1", dashboard)).toBe(standing as string)
    },
  )

  test("an open item bun run ask takes 5s to read, as under a load spike, reads as open", async () => {
    const dashboard = stubDashboard({ "#i1": 5000 })
    stubs.push(dashboard)
    expect(await readStatus("#i1", dashboard)).toBe("open")
  }, 12_000)

  test("a read past its limit still fails closed, saying it timed out", async () => {
    const dashboard = stubDashboard({ "#i1": 2000 })
    stubs.push(dashboard)
    const reason = await asDispatcher("Ship it? It is #i1.", (ref) =>
      readStatus(ref, dashboard, 300),
    )
    expect(reason).toContain(REASON)
    expect(reason).toContain("#i1 could not be read with bun run ask")
    expect(reason).toContain("timed out")
  })

  // a hook that held the stalled read would answer only at its backstop, DASHBOARD_DEADLINE_MS, past this test's own time
  test(
    "a stalled first item does not hold a second that reads open",
    async () => {
      const reason = await asDispatcher("Ship it? See #i1 and #i2.", (ref) =>
        ref === "#i2" ? Promise.resolve("open") : new Promise<string>(() => {}),
      )
      expect(reason).toBeUndefined()
    },
    DASHBOARD_DEADLINE_MS / 2,
  )

  test("a read still running when an open item passes the stop is killed with it", async () => {
    const dashboard = stubDashboard({ "#i2": 30_000 })
    stubs.push(dashboard)
    const pidFile = join(dashboard, "api", "hono", "src", "bin", "i2.pid")
    const reason = await asDispatcher("Ship it? See #i1 and #i2.", async (ref) => {
      while (ref === "#i1" && !existsSync(pidFile)) await Bun.sleep(20)
      return readStatus(ref, dashboard)
    })
    expect(reason).toBeUndefined()
    const pid = Number(readFileSync(pidFile, "utf8"))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 20 && alive(); i++) await Bun.sleep(50)
    expect(alive()).toBe(false)
  })

  test("the reads end inside the 15s both settings files give the hook", async () => {
    for (const file of [".claude/settings.json", "scripts/factory-settings.json"]) {
      const settings = await Bun.file(join(import.meta.dir, "..", "..", "..", file)).json()
      const hook = settings.hooks.Stop.flatMap(
        (group: { hooks: { command: string }[] }) => group.hooks,
      ).find((h: { command: string }) => h.command.includes("no-chat-question.ts"))
      expect(hook.timeout).toBe(15)
      expect(DASHBOARD_DEADLINE_MS).toBeLessThan(hook.timeout * 1000)
    }
  })
})

describe("a session with a manager asks it by SendMessage, never by an AskUserQuestion picker (#1758)", () => {
  const call = (tool = "AskUserQuestion") =>
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "s-1",
      tool_input: { questions: [{ options: [], question: "Which one?" }] },
      tool_name: tool,
    })
  const picker = (env: Record<string, string>, name?: string, tool?: string) =>
    check(
      call(tool),
      { CLAUDE_CONFIG_DIR: config, PLAYGROUND_DATA_DIR: join(config, "playground"), ...env },
      { itemStatus: fakeDashboard(), ownerNames: async () => OWNER, sessionName: () => name },
    )
  const refused = (reason: string | undefined) => {
    expect(reason).toContain("AskUserQuestion")
    expect(reason).toContain("SendMessage")
  }

  test.each(["probe", "reviewer", "runner", "tester", "worker"])(
    "refused: a %s by its PLAYGROUND_ROLE",
    async (role) => refused(await picker({ PLAYGROUND_ROLE: role })),
  )

  test.each(["q7w2zk-probe", "k3m9px-worker", "b7k2mq-reviewer"])(
    "refused: %s by its session name, resumed with no role",
    async (name) => refused(await picker({}, name)),
  )

  test.each(["dispatcher", "lead", "manager"])(
    "allowed: a %s by its PLAYGROUND_ROLE",
    async (role) => expect(await picker({ PLAYGROUND_ROLE: role })).toBeUndefined(),
  )

  test("allowed: the dispatcher and a lead by their session names", async () => {
    for (const name of [OLD.dispatcher, "x7mh4d-builder"])
      expect(await picker({}, name)).toBeUndefined()
  })

  test("allowed: a session with no role and no roster name, as the owner's own", async () => {
    expect(await picker({})).toBeUndefined()
    expect(await picker({}, "my-notes")).toBeUndefined()
  })

  test("allowed: the hosted session, a probe by role the Agent SDK starts", async () => {
    expect(
      await picker({ CLAUDE_CODE_ENTRYPOINT: "sdk-ts", PLAYGROUND_ROLE: "probe" }),
    ).toBeUndefined()
  })

  test("allowed: a worker's other tools", async () => {
    expect(await picker({ PLAYGROUND_ROLE: "worker" }, undefined, "Bash")).toBeUndefined()
  })

  test("run as Claude Code runs it, a worker's picker is refused with exit 2 and the reason", async () => {
    const run = Bun.spawn(["bun", "--no-env-file", script], {
      env: { ...process.env, CLAUDE_CODE_ENTRYPOINT: "cli", PLAYGROUND_ROLE: "worker" },
      stderr: "pipe",
      stdin: new Blob([call()]),
      stdout: "pipe",
    })
    expect(await run.exited).toBe(2)
    refused(await new Response(run.stderr).text())
  })
})

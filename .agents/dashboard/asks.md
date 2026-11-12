- Playground's Inbox is what the factory posts for the owner: a decision to approve, a draft to send, or an update to read.
  It replaced the asks (their JSON files, locks, in-chat cards and `/dashboard/asks`) and the old approval channel.
  It is one table, `inbox_item` (`packages/db/src/schema/inbox.ts`), in the dashboard's local Postgres, read and written through `api/hono/src/lib/dashboard/inbox.ts`, whose zod schemas check each kind's payload,
  and served by `/api/v1/inbox` (`GET` the list, `POST /api/v1/inbox/:id/answer`, `POST /api/v1/inbox/:id/retry`, `POST /api/v1/inbox/dismiss`, `POST /api/v1/inbox/read`, `POST /api/v1/inbox/:id/schedule`, `POST /api/v1/inbox/:id/secret` for a secret ask's value, `POST /api/v1/inbox/:id/reveal` for a reveal card's (both below), and `GET /api/v1/inbox/attachments/:id` for an ask's, a draft's,
  a `slack` decision's or a read-only update's files).
  It shows first in the aside window beside every dashboard page (`DashboardAside` in `web/next/src/components/dashboard/dashboard-aside.tsx`, drawn once by `web/next/src/app/(protected)/dashboard/layout.tsx`, so the Inbox and the chat are on every page and only the session panes differ by view),
  in stock Tabs whose squares float centred over the bottom of that half in the table's selection-bar look (`FLOATING_BAR`), one icon square a tab, `APP_SQUARE`'s shape (`iconTab` in `web/next/src/components/dashboard/dashboard-aside.tsx`), in one row that scrolls sideways once the squares outgrow it (`TAB_BAR`),
  above every layer a pane holds, since the panes stack in an isolated layer of their own (`PANES`, since a table's sticky header once painted over the bar),
  hidden as a dock is until the pointer comes within 96px of the half's bottom (`BAR_NEAR_PX`; a pointer over a portal opened from the aside, the viewer, counts for nothing, #i949) or a key's focus lands in it,
  unless the owner unticks Auto-hide tab bar at the top of the user menu, which keeps it shown (a wide screen's alone, since a phone's bar never hides), the choice kept in this browser,
  and shown see-through over the pane (`bg-popover/60` with a blur; a bar that hides itself, see-through in place of black), a drawer handle named Show tabs marking where it comes back, wearing the squares' red dot (`CountBadge`) while something is new,
  so each scrolling pane ends 12px under its last line (`PANE_BOTTOM`) and the chat alone keeps the bar's room (`BAR_ROOM`, `CHAT_BOTTOM`), every pane taking `BAR_ROOM` while Auto-hide is off,
  its count inside a red dot at the square's top right, and something new on a square with no count the plain red dot (`cornerMarks`, `.agents/dashboard/sidebar.md`), each tab's name its hover and screen-reader words, Inbox (the default),
  then Playground's chat on every page but your chat, which is that chat itself, then a square for each app you show, in your order (#i787, `.agents/dashboard/apps.md`), then Pages on a session's own view alone, then each page or document open in the aside in the order it opened (below), then Apps, the app manager,
  last of the tabs (`asideTabs`, `.agents/dashboard/dashboard.md`; on a phone the page's own square leads them, at the bottom),
  then a Settings square, a link to `/dashboard/settings` (`SettingsSquare`), which the user menu lists too,
  as one plain list in priority order (`components/dashboard/inbox.tsx`):
  decisions and drafts that need the owner and answers that failed to send, then unread updates, then the rest: every card that waits on a verb at any age (answered or read since `CLOCKS_STOPPED_AT` in `@packages/config/inbox`, and not yet acked or dismissed, `listItems`),
  and whatever else moved in the last week, each newest first by when it was posted (`inboxOrder` in `api/hono/src/lib/dashboard/inbox.ts`, #i545), that order read once when the list opens,
  after which each item keeps its place instead of jumping the list: one that arrives waits behind a pill on the open row (below), white, left of Mark all as read, on that one line at every width (its words truncating first, the pill reading `1 new` in a pane under 24rem, its whole words still read to a screen reader),
  so it never covers a card and its coming and going moves nothing,
  sliding in and fading out (none under reduced motion), `1 new update` (`pinnedView` and `newLabel` in `web/next/src/lib/inbox.ts`), whose click puts what waits on top (the order lasts as long as the page, so what arrives while they are on another tab waits behind the pill too), newest first, the rows below gliding down (none under reduced motion);
  a take by the keyboard hands focus to the first card it puts on top (`focusAfterTake`), since the pill leaves; and the action buttons of every card that moved pause for 1 second (`movedRows`, `MOVED_PAUSE_MS`, the guard a short pause so a stray click during the move cannot misfire), still focusable and saying why on hover,
  while each such card's comment box and a secret ask's value field stay enabled,
  so focus and a dictated paste stay in them (a disabled field drops focus to the page), and turn read-only only while an answer is on its way;
  the comment box lands a paste as the text its event carried (`insertPaste`), as the composer does (messages.md), since the browser's own insert reads the clipboard again, which a dictation app may have put back by then;
  Each card is a stock Card holding one question, or a `questions` list of 2 to 20 asked one at a time (below), on shadcn's Questionnaire (its title the item's, its description what Approve does or, once it is answered or settled, the result, on its own line above the footer; Cmd/Ctrl+Enter in a draft's box presses Send, and on a decision sends the picked option, once one is),
  and its footer holds the item's actions on the left and its verbs then Reply on the right (`verbs` in `web/next/src/lib/inbox.ts`), Seen being the band's tick (below):
  Seen while unread, then Later, Archive and Dismiss while it waits; Done, Later, Archive and Dismiss on an update in the list; Done and Dismiss once answered, working or failed; Later, Move back and Dismiss on the Archive shelf; and Dismiss on Done until it is dismissed, with Move back on one set aside while it waited,
  then the expand chevron before Reply on every card, folded rows included (#i510, ib-7), with Send leading an open decision's footer, and Submit an open secret ask's (below);
  a card moves by a verb alone, never by a clock: a go its poster has not closed (below) moves to In progress once answered, a no-go (Deny, Discard, Submit, an accept the Dashboard ran) to Done, newest first, and a read update stays in the list;
  an update (read or not) or an answered decision or draft moves to Done at once when the owner presses its Done or Dismiss (`dismissItems()` records `dismissedAt` inside its answer, so no column was added, and marks an update read, keeping the time it was read; the dismiss buttons exist so the owner can clear any item from the list),
  so nothing is deleted (`inboxView` in `web/next/src/lib/inbox.ts`; an update read before `CLOCKS_STOPPED_AT` stays in Done, where the 10-minute clock had moved it).
  An answered decision or draft moves to Done at once when its poster closes it, by `bun run ask ack`, by a `bun run ask get --ack` that closes it or by `bun run ask settle`, since `stamp()` and `settleItem()` in `api/hono/src/lib/dashboard/inbox.ts` write `dismissedAt` with the close;
  one set aside by the old `clear` and not dismissed keeps its Archive shelf, and a go read but not yet carried out stays on In progress.
  Dismiss takes a decision or draft answered by a reply too, moving it to Done at once while it stays open for its poster, so an answered item leaves the list.
  Mark all as read on the open row marks every unread update and open decision or draft on screen seen (`markRead`), answering and dismissing none, so each stays in the list as it is until it is done, shown only while one is left (`unreadIds`; a read mark leaves each item in the Inbox until it is done).
  The Inbox is one shadcn Accordion with six rows (in that order, gray and all caught up when nothing is open, an icon and a word on each label): the open items, starting open (`FOLDS_OPEN`), then the shelves In progress, Later, Archive and Done, starting shut,
  each row's header sticking to the top of the pane while its section scrolls,
  with a full-width line under every header but the last row's while it is shut (the row classes live in `web/next/src/components/shelf.ts`, which the Changelog shares).
  Each row ends in its `ShelfMark` (`web/next/src/components/shelf-mark.tsx`) in place of the stock chevrons: a small circle on an empty row, else a right chevron turning down while open, on a muted square while the row is hovered ("show circle icon if no items in accordion, and right chevron on closed?", "and hover state like this").
  The open row reads Inbox and the open cards' count as the shelves' Badge, 0 included ("still keep showing counts", "all caught up to inbox then label count", "where is inbox zero"), the summary of the open cards, or All caught up, in an `sr-only` span, Inbox muted with the row disabled when none is open;
  the pill and Mark all as read (a single ✓ icon button, `RiCheckLine`, its Hint naming how many it reads, while anything is unread, else a muted ✓✓ named All read) sit over its right end, outside the trigger, so pressing one never folds the row.
  Before the first read lands, the open row is already in its place, muted, its count shown only once the read lands (a Badge beside the Spinner counts nothing), and the room for Mark all as read kept, with the Spinner under it and no shelf, so the read lands below it and moves nothing (`InboxLoading`).
  A shelf's row is its icon, its name and its count as a mono outline Badge, every shelf counting what it holds, disabled and gray while empty (`ShelfLabel`): In progress holds a go its poster is carrying out, from its answer until its poster closes it or the owner presses its Done or Dismiss (`progress` in `inboxView`, the `sending` of `itemState`),
  offering no ✓ since its poster closes it;
  Later holds the open items and updates put away until a time still ahead, which the API returns apart from `items` as `snoozed` (`listItems`), since every other reader of `items` takes a row there as awake;
  Archive holds what the owner archived, which the API returns apart from `items` as `archived` for the same reason, and the ones set aside by the old `clear` not dismissed, however old, each the same card it was in the list, with no shelf mute (its title quiet as any answered card's),
  offering Later, Move back and Dismiss (Move back and Dismiss alone on a `cleared` one, no longer open), and the row's header a ghost Dismiss all in Archive (a ✓, `RiCheckLine`, `ShelfDismiss`), which does to every card on it what that card's own Dismiss does, one after another (`dismissEach`):
  one that still waits is set aside, its poster told `set-aside`, and anything else marked dismissed, its poster told `dismiss`;
  Done the rest of what settled, its header's ghost Mark all in Done as read (`ShelfDismiss`, "where is done mark as read") marking every item in it read, through `dismissItems`' `dismissedAt` on each not yet stamped, and typing nothing into any session,
  gone once none is left ("why mark as complete is available at 0 here"), as Dismiss all in Archive is, and its count everything it holds, its history too ("done show 0 and yet items?"), with `, N unread` for a screen reader,
  its row muted once none is unread, as an empty one is, though it still opens to its history, full again on hover or while open ("Why at 0 is it not muted like others?").
  Each shelf's place (`progress`, `snoozed`, `archived`, `done`) is its key in the accordion and decides what its row does (`shelfRow` in `web/next/src/lib/inbox.ts`), while its words come from `SHELF_LABELS` alone, so renaming a row changes only what it shows.
  Under Done sits the Preview row, its icon and name with no count, starting shut and there in an empty Inbox too: opened, `PreviewPane` in `web/next/src/components/dashboard/preview-pane.tsx` fills the pane below it with a frame down to the pane's bottom edge.
  Its picker lists every project's worktrees on this machine, one group a project (`GET /api/v1/stacks`, `readStacks()` in `api/hono/src/lib/dashboard/stacks.ts`): the projects are this checkout's and each live session's folder's, their worktrees read from git's own files, each labelled by its branch and the session working in it,
  running where a portless route's process group is one its stack's record (`.turbo/dev.pgid`) names and stopped otherwise; a web stack no worktree claims lists under its app's name, and a fixture stack lists the fixture's made-up `worktrees`.
  A stopped worktree picked shows Start in the frame, which starts it as a Vibeground (`POST /api/v1/stacks/start`, `startVibe()` in `api/hono/src/lib/dashboard/vibe.ts`, stack.md) and opens it once it serves, one started and not serving yet reading starting in the list and showing Starting with Stop in the frame,
  and a running Vibeground (`vibe` in the list, its `.turbo/vibe.json`) shows Stop in the bar (`POST /api/v1/stacks/stop`) and, under it,
  its badge (`vibeLabel()` in `web/next/src/lib/test-data.ts`) and Done, the owner's click sending the dispatcher `doneMessage()` (`web/next/src/lib/previews.ts`) through the outbox,
  since the message route reaches the dispatchers and the assistant alone: it names the worktree, branch and session, for the dispatcher to route, to push to the branch's open PR, else open one into its parent, never merge;
  a fixture stack marks its made-up worktree running or stopped in the scratch copy.
  The 8 newest Previews pages follow, which load sandboxed with no script.
  A stack's link opens in a new tab with the bar's open-out button, where it works as itself on its own sign-in; the sidebar's brand opens the Inbox tab with this row open (`openPreview()` in `web/next/src/lib/previews.ts`).
  Its address field loads only a `.localhost` stack or a Previews page (`loadable()` in `web/next/src/lib/previews.ts`), and the last address is kept in localStorage.
  An empty row is always shut and gray with the default cursor, and the open list keeps the owner's open or shut while it is empty.
  The open cards stay mounted while folded, so a fold keeps an edited draft or a picked option, and taking what waits behind the pill, or a link to a card in the folded list, opens the list first.
  Each item sits flat, led by one muted band the pane's full width (`KindBand`, `bg-muted` with square corners bleeding over the pane's `--pane-x` padding, which `dashboard-aside.tsx` sets on each scroll pane, its words lined up with the card's),
  which gives its kind as an icon and a word,
  its id `#i<ref>` (`ref` is an identity column, so an id is stable and never reused) and who posted it (Alpha's name `text-info`, Bravo's `text-bravo`, the theme's purple), then at its right end one time and a tick: `posted <time>`,
  or `updated <time>` once a decision or draft changed (its `updatedAt` a second or more after its `createdAt`, both stamped by the API's clock: an answer, a delivery, an ack, a settle, an edit or a Later, `scheduleItem` setting it too), or once its poster edited an update (`bun run ask edit`; an update's read, Dismiss or resolve leaves it `posted`;
  `changedAt` in `web/next/src/lib/inbox.ts`), reading `read <time>` on hover once read, and a blue `Updated` when it changed after the owner's look before this one and by the time this one began (`updatedSince`; the inbox's look mark, `inboxMark` in `web/next/src/lib/tab-dot.ts`, takes in changes too), so a change made as the owner looks shows in place, with the change's own time beside it,
  since a relative minute alone can hide an update that landed after the last look.
  Colour says what an item is and where it stands, as the sidebar's lights do: its kind's on its icon alone (a decision `warning`, a draft `info`, an update `success`, an alert `destructive`), the card's own edges plain, no thick coloured border,
  and its state as the sidebar's Worker Lights draw the state that means the same, beside its title and in its result line's colour (`itemState`, `inboxLight` in `web/next/src/lib/inbox.ts`, its icon and tone read from `statusIcon` in `web/next/src/lib/status-icons.ts`, the one table),
  the kind icon sitting in the band and that light in a leading column centred on the title's first line (`LEAD` in `components/dashboard/inbox.tsx`):
  the orange eye while a decision or draft waits on the owner, the blue spinner while a go is being carried out (turning only where motion is allowed), the green check once its poster closed it, the result link green too, or once every environment took a secret, whether or not its poster was told,
  the red error when any other answer failed to send, until the owner dismisses it, or when a secret's sink refused it, which stays as its record,
  and the gray circle once denied,
  discarded, set aside (`cleared`), settled or read,
  or a failed send dismissed;
  an unread update keeps its dot.
  An `ask`'s text, and a read-only update's, renders as a chat message's does, through `TranscriptMarkdown card` with its line breaks kept, so a fenced block (`ts`, `sql`, `diff`, `text`) shows highlighted with its copy button, at text-xs and wrapping at any character, a `diff` block's added and removed lines tinted as a chat message's are (`messages.md`).
  A drawing (a `text`, `txt` or `ascii` block, or one with no language) keeps its lines whole, its font shrinking from 12px to fit its widest line, measured with pretext, down to 10px before it scrolls sideways.
  `ASK_CODE_COLUMNS` (`@packages/config/inbox`) is the widest drawing line that fits the narrowest card at 12px.
  A `delete` decision's `why` renders the same, so a link it holds opens, while its `what` stays plain text, the paths Approve removes.
  Every other preview's words, a Slack message's included, stay plain text, since they go out exactly as written, marked as quoted by a `border-l-2` rule rather than a background, and no card's body, a Done one's included, sits on gray, the band alone muted.
  The card's header is one `minmax(0,1fr)` column and a card's table cells wrap, so a wide table or drawing stays inside the card.
  A decision previews exactly what Approve does, then its options as shadcn's questionnaire choices, except a secret ask (below), and no card offers Edit: a change goes in the comment box, while the API still reads `edit` on an older row.
  Its options are `choicesOf` in `@packages/config/inbox`, in one of two shapes.
  A yes or no is two rows, Approve and Deny, each over its own label: an ask's one `options` row (or its older `approve`) and its `deny`, a typed decision's default labels from the one map there, or an unlabelled ask's bare Approve and Deny under its On Approve line.
  Real alternatives are lettered rows, A to E, each its label over its `description`, then None of these, or the ask's `deny`.
  A multi-question ask steps instead of choosing once: its 2 to 20 `questions`, each its own lettered rows (`questionsOf`, not `choicesOf`), shown one at a time with the recommended one (`recommended`) badged where it sits.
  The number keys pick a row, 1 for the first, and the card's footer sits inside its form, Send first, the form's Submit, which sends the picked option,
  off until one is picked and saying `Pick an option first` on hover and to a screen reader (`sendWhy` in `web/next/src/lib/inbox.ts`, the submit disabled while no option stands and placed on the left), then its verbs (`verbs()`), the chevron and Reply;
  a multi-question ask adds Progress, Previous and Next between its questions, and its Send posts one pick per question once every one is answered, saying `Answer every question first` until then;
  a draft is its Slack message or Linear comment, named so from its `link`'s host (`linear.app` is a Linear comment, anything else a Slack draft) with an Open thread link to it in its place line, editable in place, then Send, Draft for a Slack draft alone and Discard (for the apps whose drafts a person sends themselves):
  Draft saves it in Slack's Drafts & Sent for the owner to finish and send, which its poster does with Slack's MCP tool `slack_send_message_draft` and acks with the `channel_link` it returns,
  rewritten to the app form by the command `slack.linkConverter` names (the archives refusal, below) since `ack` refuses its archives form,
  or with `--no-link` with why when Slack refuses with `draft_already_exists`, since a conversation holds one draft, which the owner's card then reads, gray, as `Draft not saved: <why>`,
  since Slack's public Web API has no draft method and Linear's API has no mutation that creates a draft, so a Linear comment offers none and the API refuses `draft` for one (`savesDraft`, which the web's `canDraft` mirrors);
  Archive (`RiArchive2Line`, the Archive shelf's icon; the action `archive`) takes what waits, or an update in the list, off the list and its count unanswered: it stays as it was with `answer.archivedAt`, so no column changes, and its poster is typed nothing and keeps waiting.
  Move back (`RiInboxUnarchiveLine`; the action `unarchive`) returns an archived item to the list as it was, and takes one set aside (`cleared`) back to `open` with no answer, from Archive or Done, so it is answered again;
  it types nothing into its poster, since nothing was decided, and the card takes the list's top as it arrives rather than waiting behind the pill, since the click was the owner's own (`back` in `Inbox`); the API refuses it on anything neither archived nor set aside.
  Dismiss (`RiCloseLine`; the action `dismiss`) sends a card to Done marked dismissed (`answer.dismissed`); on what still waits, a secret ask and an archived one included, it records a set-aside with it (status `cleared`, choice `clear`, neither a deny nor a discard and never a go).
  Its poster gets the `set-aside` verb: whatever is already in motion stays in motion, only the new step the item asks for waits, and the owner picks the talk up again; its read (`playground ask get --ack`) closes it, as a deny's does, and the action `clear` still sets an open item aside the same way for an old caller.
  On anything else (an answered, working or failed item, a reply, an update, or a card on Done not yet dismissed) Dismiss marks it dismissed, keeping when it first went to Done, and reads an update.
  Its poster gets the `dismiss` verb, drop it (`closedPayload`), with the `close` that closes a card it has not closed yet; a card its poster already closed, or an update Done already told, is typed nothing again.
  Done (`RiCheckDoubleLine`, `POST /api/v1/inbox/dismiss`, `dismissItems()`) sends an update or an answered card to Done unmarked, waking one put off or archived, so Done's own Dismiss stays on it until the owner dismisses it.
  On the card's own Done (`tell`, which a shelf's bulk leaves out), an update's poster gets the `done` verb, so it posts a new card for more rather than editing this one, which `ask edit` now refuses; an answered card's poster is typed nothing, since its answer already reached it.
  The band's tick sits after its time:
  while a card in the list is unread (`readAt` null; Seen in `verbs`) the tick is a single ✓ button, Mark as read, which only marks it seen through `POST /api/v1/inbox/read`, taking any kind, so an ask stays open and answerable, its card as it was ("once mark as read, keep the message as is"); once read it is a muted ✓✓ named Read, its Hint the full time it was read.
  The unread dot stands in for an update's light alone; an ask keeps its light ("what is this dot before the icon?").
  Each verb is an icon button too, named in its `aria-label`, its `Hint` saying what it does ("should be just icon in this case also").
  Every open card ends in a comment box above its buttons, named Comment, the same gap above it as between the card's other parts, at least as tall as its first choice (`NoteBox`):
  on an open decision or draft it reads Add an optional comment, and what the owner types there goes with whatever he answers, as `answer.note` (at most 4000 characters), its poster reading it as the answer line's `comment`, the answered card reading `You: ...` under its result and the box emptying;
  on any other card (an update, an answered card, a secret ask) it reads Add a comment, and Reply alone sends it.
  Reply (the reply icon, named `Reply to #iN`) with the box empty hands the card's ref to Playground's composer (`outbox.reply` in `web/next/src/lib/chat.ts`, `replyRoute` and `withRef` in `web/next/src/lib/reply.ts`),
  which starts with `re #iN: `, before the words it held and in place of another item's ref they opened with, the aside showing that chat, with focus in its box in the click's own frame and the caret at the end, so a dictation app's Cmd+V sent at once lands there (`bun run verify reply-focus`);
  a secret ask's or a reveal card's Reply opens its own box instead (`keepsReply`), so a secret never reaches the chat, and so does any card's while Playground's session is down (`dispatcherOf`), since no composer would take the hand until it is back, and a folded card's with words in its box;
  with words in the box it sends them alone through `POST /api/v1/inbox/:id/reply` (`replyItem()` in `api/hono/src/lib/dashboard/inbox.ts`), typed into the poster through `deliver()` as `re #iN: <words>`, or into the dispatcher once the poster has ended (`posterGone`), the box emptying once it is in;
  one that reaches no session is refused with why, its words kept in the box.
  On an open decision or draft with no answer yet it is recorded as his reply (`recordReply`, below), and the poster changes the card in place with `bun run ask edit`, which takes the reply off (`editItem()`), so the card waits on him again, open and marked Updated; on any other card the answer and its delivery stay as they were.
  A card's words, its preview (an ask's callouts, tables and inline code included), a draft's box and the Note, read at `text-xs` (`BOX` in `inbox.tsx`, whose `md:text-xs` beats the Textarea's own `md:text-sm`).
  A go row and Send take a muted green, the no-go row, Send once it is picked, and Discard a muted red, and Draft amber (`SIDE_TONES` and `DRAFT_TONE` in `inbox.tsx`), on the choices and the footer buttons alike.
  Later (the zzz icon, `Schedule` in the code) puts an open decision or draft, or an update, away until a time, while it waits, one put away already included, while an update is in the list, and on an archived card, which it takes off the Archive shelf:
  its fixed times in the owner's zone (the `clock.ownerZone` setting, its label naming it), soonest first, each beside its day and time (`scheduleChoices` in `web/next/src/lib/inbox.ts`, with more than one default to pick from):
  In 30 minutes, In 1 hour, In 3 hours, This evening 18:00 while it is ahead, the next 09:00 (Today or Tomorrow), Monday 09:00 (the coming Monday) and Next <weekday> 09:00 (today's weekday a week out), a moment two of them share kept once; or Pick a time…, shadcn's date and time picker (the Calendar in a popover beside a time field, in the browser's time zone) with a Set button;
  `POST /api/v1/inbox/:id/schedule` takes `{ at }` as ISO and is guarded like an answer, `scheduleItem()` recording `answer.snoozedUntil` on the item and dropping an archived one's `archivedAt`.
  A sleeping item leaves the list and the count until its time (the list SQL's `awake` fragment) and asks again once it has passed, new to the browser tab's dot again (a wake after their last look counts as new, a look after the wake clears the dot);
  a reply (`re #iN`) wakes it at once by replacing the whole answer with the reply, so it reads `You: "<his words>"`, while an item woken by its time passing offers Later again (`schedulable`).
  While `playground focus` stands (its `focus.json` in the data folder, read by `standingFocus()` in `api/hono/src/lib/dashboard/focus.ts`), an item that comes in is stored as any other but held quiet: the list's `quiet` names it (`quietIds`), the count, the tab's dot and the Inbox square's count leave it out (`loudItems` in `web/next/src/lib/tab-dot.ts`), and its card reads Quiet after its kind;
  a look at the Inbox marks it seen with the rest, since the list shows it, while Needs you and a session row's waiting light, which read the list's items, still show it;
  an `alert` update stays loud, the 5% battery alert among them.
  Once focus ends, by `playground focus off` or at its end, ops-tick's focus card beat posts one update naming the runs that queued while it stood and their wait, and each held item counts again;
  the beat resolves that card once `bun run ask open --since <focus start> --until <focus end>` lists no ask, since everything it pointed at is answered.
  An update is an outcome, bold with a dot until a click on its title, its tick, its Done or its Dismiss marks it read; Done and Dismiss also move it to Done, and Mark all as read on the open row marks every update read.
  An update whose `approve` holds a web link, a Yard post Yard holds for the owner (`pendingCard` in `api/hono/src/lib/yard/inbound.ts`), shows Approve first, a link button that opens that page in a new tab, since only the owner's signed-in browser approves on Yard; the card records no answer of its own.
  Its poster resolves its own update once it has settled, with `bun run ask resolve <id|#iN> --by <your session name> --note "<why>"` (`resolveItem()` in `api/hono/src/lib/dashboard/inbox.ts`): an alert whose cause cleared, a progress card whose last step is done (to-inbox's PROGRESS.md), the focus card once what it pointed at is answered.
  A resolve marks it read and merges its keys into the answer, so the card moves to Done with its note and the owner presses nothing, and a resolve after the owner's Dismiss leaves the item dismissed; only the posting session resolves its update, and a decision or draft settles instead.
  An answered card's result line names what was picked, in the card's own words (`outcomeLine` in `web/next/src/lib/inbox.ts`):
  `B · Hotfix main` for a lettered pick, `A. staging · C. soon` for a multi-question ask's one pick per question, `Approve · Ship 3f9a2c1 to main` for a yes or no, a bare `Approve` or `Deny` for an unlabelled ask, `Sent`, `Saved as a Slack draft`, `Discarded` or `Archived <time>`,
  then a state only where the answer did not simply go through (`Queued for <taker>`, `Send failed: <why>`, `No link: <why>`), never a word typed for its poster, since its light says the rest.
  A go's light stays blue while its poster carries it out (an accept, an apps change, a guard setting or an own account change the Dashboard ran, or a grant whose pane failed to open, reads its result after the pick, and a grant whose pane opened reads that line, below),
  until its poster closes it, even once typed into its session,
  since only the ack says it landed (#i115's earlier Delivered word read as landed when it was not).
  A `<taker>` is the session that took the answer: its poster, unless the poster has ended.
  An answered item's result line ends with a link to where its poster carried it out, when the poster acked or settled it with `--link <https url>` (stored as `answer.link`; a Slack link in its `https://app.slack.com/client/<team>/<channel>` form, a message's ending `/thread/<channel>-<ts>`), named for what was done by `--label` (`answer.linkLabel`, "Filed FIX-12"),
  else from the link (a Linear ID, `owner/repo#N`, Open thread for a Slack link, else the site), opening in a new tab (`resultLink` in `web/next/src/lib/inbox.ts`; a result carries the link it acted on, so the reader can open the thread or ticket themselves).
  Words in Playground's composer that say `re #iN` name the item: the composer shows a Replying to #iN chip and its card's band reads a Replying chip (an outline `Badge` at the band's line height, `h-4 text-2xs`, after Updated) until the message is sent (`web/next/src/lib/reply.ts`), and the API records the message as his reply once it reaches the dispatcher.
  A reply, from the card's Reply or the chat, takes the item off the open row's summary at once, while its card stays in the list, since the owner still owes its answer, until its poster closes it or the owner presses its Done or Dismiss, and the owner's card reads `You: "<his words>"`, its light blue until the poster closes it:
  the reply keeps his words after the tag, at most 280 characters (`said`, `saidOf`; so the item shows what action it is on).
  Until then the card folds to that line, and its chevron left of Reply (Expand, then Collapse once open, on every card), a click on the card or E while it holds focus opens it again with its answers and verbs (`reopenable` and `reopenKey` in `web/next/src/lib/inbox.ts`).
  Every other card that needs no answer now folds the same way by default, on every shelf, so the ones that need one stand out (`foldsByDefault`): a read update, an answered decision or draft, one put away with Later until its time, and each card on In progress, Archive and Done.
  An open decision or draft not answered by a reply, an answer that failed to send and an unread update show open, and a card that rises to one of those shows open.
  A folded card shows its band, place line, title and result line, and keeps its row of choices: its verbs, the chevron, and the answers that need nothing its body holds (an update's Approve link, Retry and Check it for me, not a decision's pick, a secret's value or a draft's words);
  opened, it shows its words, files and footer, and keeps that while it stays on its shelf with the Inbox mounted, its row shut and opened again included, since every shelf's panel stays mounted while shut; a card that moves to another shelf arrives folded again.
  A draft card's changed words are kept in this browser under its item's own key in the composer's draft store (`cardDraftKey`, `web/next/src/lib/drafts.ts`) while the card can still take them (open, or one a reply collapsed), so a list refresh or a shelf move that remounts it gives them back; words put back as posted remove the key, and the card clears it once answered, settled or archived.
  An ask card's answer in progress is kept the same way, under its own id in a picks store (`web/next/src/lib/ask-picks.ts`): the option picked for a single-question ask, each question's pick and the question in sight for a multi-question one, and the Note on either, all given back on the same remount.
  The pick(s) and step are stamped with a signature of the questions, or of a single ask's choice rows, and drop when that set changed under the unmounted card, while the Note stands on its own; the card clears the lot once answered, settled or archived (`schedulable`).
  An answer given there, or a Later through the API, replaces the reply (`answerItem`, `scheduleItem`), so the poster reads that one alone and is chased for it alone, a Later reading as no answer until its time, so the poster's `bun run ask ack` of the reply is refused with `This item has no answer yet`; once the poster closes the reply, the card takes neither.
  A session that posted an open decision or draft depends on it, so until the owner acts on it, by a button, a Later or a reply, it reads Waiting on your inbox, with the orange eye, linked to that item, in the sidebar and the System page's table (`inboxWaitOf` in `web/next/src/lib/inbox.ts`, through `statusOf` and `rowLines`),
  and ranks with the sessions at a prompt;
  with nothing open or running it reads Idle (playbook's **ask** rule).
  The answer is recorded in one write that holds only while the item is open at the version read, then typed into the posting session through `deliver()` as one line, `[inbox-answer] {json}` (`answerPayload` and `answerLine` in `inbox.ts`), and the item records how that delivery went.
  The JSON is `answerPayloadSchema` in `@packages/config/inbox` (`payloadOf` parses a line): the item's `ref`, `id`, `title`, `kind` and a decision's preview `type`; the `verb` (`ANSWER_VERBS`: `pick` an option, `send`, `draft`, `discard`, `set-aside`, `submit`, and `dismiss` and `done` for a card the owner closed, below); `go`, whether to carry it out; `next`, `carry-out`, `close` or `nothing`;
  and `close`, the exact command that closes the item, a `playground ask ack` or `playground ask get --ack` that runs from any worktree (on a live-reads test stack that checkout's own `bun run --cwd <checkout> ask`, `askCli` in `inbox.ts`),
  naming `--no-link "<why>"` beside `--link` for a go that may leave no page (a decision whose preview names no `link`, a Save as draft), and left out where nothing is left to close: an update, or a card its poster already closed.
  A pick names its `option`, the row the card showed, by `index`, `letter` and `label` (`choicesOf`): a yes or no's Approve is A and its Deny B, and a lettered ask's None of these takes the letter after its last option.
  A multi-question ask's payload names `picks` instead, one entry per question with its `question` and the same three fields (`picksOf`).
  His comment rides as `comment`, a changed draft's words as `text`, a Slack draft's link command as `linkConverter`, what the dashboard ran on Approve as `accepted` (an accept),
  `listed` (an apps change), `set` (a guard setting), `owned` (an own account change) or `opened` (a grant's pane, whose `next` is the recheck below) and a secret's sink results as `results`, never its value.
  A comment alone (the card's Reply or a chat reply, `re #iN`) stays his own words, typed as he wrote them.
  In every chat the line reads as one answer chip in his bubble, an outline badge holding the item's `ref` and the option's `label`, else the `verb`, with the `comment` as the bubble's words after it (`answerChipOf` in `web/next/src/lib/answer-chip.ts`, `TranscriptBubble`), and a line `payloadOf` cannot parse shows as written.
  A click on the chip opens that card in the aside's Inbox, opening the shelf that holds it first.
  A page loaded with a card's anchor in its URL (`#needs-you-<id>`, a link or a reload) leaves every shelf shut, so only a click on a chip or a sidebar row opens one for its card (`shelfToOpen` in `web/next/src/lib/inbox.ts`, the hook's `TargetSource`).
  A poster that has ended (the delivery reads `NOT_FOUND` with deliver.ts's reason `No live session is named <poster>.` or `<poster>'s Claude is not running in its pane any more.`; `posterGone` in `inbox.ts`) hands the answer to the dispatcher instead (`DISPATCHER`, which the router passes to `answerItem` and `retryDelivery`; `textsOf`).
  Any other `NOT_FOUND` (`now names another session`, `has no terminal to type into`) comes from a live session and stays failed, so the go is never carried out twice.
  A sessions read that was cut short (`Live.partial`, herdr.md) that misses the poster is read once more, fresh rather than the hub's board, and still missing it reads `SESSIONS_FAILED`, never `NOT_FOUND`, so a live poster's answer is never relayed (`target()` in `deliver.ts`).
  The dispatcher is typed the same line with `relay: {for: <poster>, why: "poster-ended"}`, and reads the preview with `playground ask get`: a `next` of `carry-out` it carries out in the poster's place, a sent message through the MCP server `slack.sendServer` names (else its Slack tool), then runs `close`; `close` or `nothing` has nothing to carry out, only the `close` to run.
  That delivery records `delivered` with `to`, the session that took it: the dispatcher here, the poster otherwise.
  A row from before `to` was recorded has none and reads as its poster (`takenBy` in `web/next/src/lib/inbox.ts`).
  The card names that session where the answer waits on it or may not have reached it (`Queued for <dispatcher>`, `Send unconfirmed: whether <dispatcher> has it is not known`).
  The answer line reads the delivery as the session has it, in three states: queued, delivered or lost.
  Queued: `deliver()` reads `QUEUED`, Claude Code holding the answer while the session compacts or works, and the delivery records `{at, id, status: "queued", to}` with the try's own id, the line reading `Queued for <taker>`.
  The API reads it again under that id every 5 seconds (`follow` in `inbox.ts`, `QUEUED_POLL_MS`), typing nothing, and records what it settles to while the item still reads queued under that id: delivered once the transcript shows it, or failed as `LOST` once neither the screen nor the transcript shows it 10 minutes on.
  A transcript that cannot be read back that far fails it as `INTERRUPTED` (unconfirmed) instead.
  Each of those reads carries the delivery's `at` as `queuedAt`, and those reads are the API process's own, so a restart ends them: a card still reading queued `STUCK_QUEUED_MS`, 11 minutes, after its `at` (`stuckQueued`) offers Retry, which reads it again under its own id and `queuedAt`, typing nothing while Claude Code still holds it.
  A relay that fails records the dispatcher's own failure, and an item the dispatcher itself posted is never relayed.
  An answer whose delivery failed (on 9 Oct, 11 failed unseen with the code now named `SESSIONS_FAILED`, and #i76's Send never went out) still needs them (`deliveryFailed` in `api/hono/src/lib/dashboard/inbox.ts`, `sendFailed` in `web/next/src/lib/inbox.ts`):
  it stays in the list and its count past the week, its result line in red reading `Send failed: <reason>`, `Lost: <reason>` for `LOST`, or `Send unconfirmed: whether <taker> has it is not known` when typing began or a held answer's transcript could not be read back (`INTERRUPTED`), or the adapter threw (`ERROR`), so the answer may be in the session already;
  an unconfirmed one offers Check it for me (`sendUnconfirmed`), which sends the dispatcher a note through the outbox asking it to look at the poster's transcript and report (`checkAnswerNote`), since the owner works in the Dashboard alone;
  Retry is offered only after a failure that comes before anything is typed, a lost one, or a stuck queued one (`RETRY_CODES`: `INPUT_NOT_EMPTY`, `LOST`, `NOT_FOUND`, `ON_PICKER`, `SESSIONS_FAILED`, `UPLOAD_FAILED`, and `stuckQueued`,
  so it never types an answer twice) and marks it pending in one write that holds only while it still reads failed or queued at the version read and types it again (`retryDelivery`),
  until it is delivered or they press its own Dismiss;
  the session carries it out, and the Dashboard itself never sends a message, merges or files anything, sharing only a Slack send's files and running only an `accept` decision's accept, an `apps` decision's list write, a `grant` decision's System Settings pane, a `guard` decision's setting write and an `own` decision's accounts write (all below).
  No session row carries a count, Playground's included (Worker Lights): the Inbox tab counts what needs the owner and arrived since their last look at the Inbox (`newInInboxCount` in `web/next/src/lib/tab-dot.ts`, the rule `newInInbox` lights the tab dot by), so a look clears it with no answer given,
  its name reading `N new` (a click made only to clear the bar's dot),
  while the Inbox's first row counts every item in the list; the API's `inboxCount` (`api/hono/src/lib/dashboard/inbox.ts`), which Needs you and the sidebar read, counts the open decisions and drafts and the answers that failed to send, plus the unread updates, one put away with Later counted again only once its time has passed,
  and one they have replied to counted no more until its poster closes it, and the list's `count` leaves out one held quiet while focus stands, though Needs you and the sidebar, reading the items, still show it (above),
  the browser tab's red dot lights for what is new since their last look (`newInInbox`, `.agents/dashboard/sidebar.md`), and the System page's Needs you lists them, Playground's place alone.
  A session's Feed prompts show as its red alarm, Stuck (Waiting on you on Playground's own row), each shown as a card in its stream on shadcn's Questionnaire (`components/dashboard/needs-you-card.tsx`, one shape, `NeedsYou` in `web/next/src/lib/needs-you.ts`, answered through `feedNeeds()`; a permission or plan card is read-only while `PLAYGROUND_APPROVALS_ENABLED` is off).
  Items are posted only with the `bun run ask` CLI, which checks each against its kind's schema and proves its database is a container on this machine first, as `bun run ingest` does, and refuses the live dashboard's `live.container` off `live.branch`, as the launcher does.
  Before that it refuses, naming both ports, a `POSTGRES_URL` whose port is not the one in the `.env` of the checkout `dashboard-ask.ts` lives in (`checkoutMismatch` in `api/hono/src/lib/sessions/guard.ts`): a run by path from another checkout, or a URL exported in the shell over the `.env`.
  A test run (`NODE_ENV=test`) passes its own container's URL on purpose, and the check skips it.
  Run it in the checkout that serves the dashboard, from anywhere with `bun run --cwd <checkout> ask`: any other checkout has its own database, which the live dashboard never shows, and says so on stderr.
  From a worktree, run `playground ask <verb>`, the short form of the line above, which runs `bun run ask <verb>` in the Dashboard's checkout with every word and stdin passed on (`verb` in `packages/scripts/src/playground/cli.ts`), so `playground ask new < item.json` posts there.
  `bun run ask` in a worktree whose `.env` lacks the dashboard's values exits 1 on `Invalid environment variables` (measured on 11 Nov).
  From a user install's clone root with no `POSTGRES_URL`, `bun run ask` runs as the Dashboard's checkout's, the worktree on `live.branch` wherever it sits (`dashboardCheckout()`), whose `.env` holds the database, through `api/hono/src/bin/ask-from-clone.ts`; from any other worktree it runs as that worktree's own.
  A fresh worktree runs it once its `.env` is set up (the `dev` skill's Start) and its shared packages are built (`~/.playground/ops/run-slot.sh <your name> -- bunx turbo run build --filter='./packages/*'`), since a cloned `node_modules` alone leaves `@packages/db` unresolved.
  Before every `playground ask new`, run `playground ask open` and read what is already open: when an open item asks the same thing, name its `#iN` in chat and post nothing, since two sessions once posted one question as two items.
  It lists an item put away with Later and one the owner replied to, since each still asks something, until it moves to Done or its poster closes it.

  ```bash
  bun run ask new <<'EOF'   # prints the id on stdout, its tag (#i41) on stderr
  {"from": "ops", "title": "Ship canary 3f9a2c1 to main?",
   "preview": {"type": "ship", "sha": "3f9a2c1", "prs": [{"number": 270, "title": "Changelog entries read as text"}],
               "link": "https://github.com/acme/app/compare/main...3f9a2c1"}}
  EOF
  bun run ask new <<'EOF'
  {"kind": "draft", "from": "dispatcher", "title": "Ask Ivo to try the export fix", "preview": {"to": "@Ivo", "text": "hi Ivo, ...", "link": "https://app.slack.com/client/<team>/<dm>"}}
  EOF
  bun run ask new <<'EOF'
  {"kind": "update", "from": "builder", "title": "Merged: changelog entries read as text",
   "preview": {"outcome": "merged", "link": "https://github.com/acme/app/pull/270"}}
  EOF
  bun run ask new --thread <id> < item.json   # routes the item to that thread (bun run thread), refused when no thread has the id
  bun run ask open --from builder   # each open item, oldest first, one line each: its #iN, kind, sender and title; --from keeps one sender's, and --since and --until (ISO times) those posted in that window; --json prints each item whole, one JSON line each, as ops-wa reads them
  bun run ask get <id|#i41> --ack   # the item, with answer {at, choice, option?, options?, editedText?, link?, linkLabel?, noLink?, ackedAt?, via?} once the owner answers (via: "whatsapp" when the owner answered from WhatsApp) (options is one index per question for a multi-question ask; the picked option's letter and label on stderr, each question's pick for a multi-question answer, `ask: picked A: Staging first · B: After the next ship`), marked read (which closes a deny, a clear, a discard or a provided secret, not a go)
  bun run ask ack <id|#i41> --link https://app.slack.com/client/<team>/<channel>/thread/<channel>-1700000000.000100   # once carried out, a go closes with where (a Slack link in its app.slack.com/client form, which reads Open thread, so no --label), which its card links to by the label, or --no-link "<why>" when it has no page or Slack refused a Draft
  bun run ask edit <id|#i41> < item.json   # the poster replaces its own item's title and preview in place, until it closes, checked and its files copied as new does; the card redraws on the next 5s poll
  bun run ask settle <id|#i41> --note "Shipped by hand"   # the poster closes its own open decision or draft, decided another way; an update asks nothing, so settle refuses it
  bun run ask resolve <id|#i41> --by builder --note "The loop recovered on its own"   # the poster closes its own update once it has settled (a cleared alert, a finished progress card); until then it stays editable by its poster, unless the owner presses its Done or Dismiss
  bun run ask stale --minutes 15   # ops-sweep's chase: each answer given in the last 24h (--since <iso> moves that) its poster has not closed within 15 minutes
  bun run ask whatsapp <file>   # ops-wa's alone: the owner's answer to a card from WhatsApp, read from a file in <data>/whatsapp/answers/ and typed into its poster as the card's own answer is (ADR 0024)
  ```

  `kind` is `decision` (left out, it is one), `draft` or `update`; `from` is the posting session's name as the Dashboard shows it, since the answer is typed into that session; `title` is one line.
  A decision's `preview` is one of fourteen, each what Approve does except the `secret` ask and the `reveal` card (below), written in plain words (the `plain-words` skill): `accept` (`scope`, `kind`, `key`, `rev`, `why`, an optional `more` list, below), `apps` (`app`, `change`, `why`, below), `ask` (`text`, what its poster does on Approve, for a decision no other shape fits:
  a production port, a work request from outside the chain, its text naming the session asking and the work it wants, or a step only the owner can take, its text the step,
  Approve meaning done and Deny meaning the owner can't, or a grilling batch, its text each open question numbered with its recommended answer, Approve taking them all and the owner's Note giving his own by number;
  with its options labelled one line each, `options`, 1 to 5 rows of `{label, description?}`, one row for a yes or no and 2 or more for lettered choices, or the older `approve` alone, never both, and an optional `deny` naming the no-go row (Deny, or None of these past one option),
  or a `questions` list of 2 to 20 entries for a card that asks one question at a time, each `{question, options, recommended?}` with its own 1 to 5 `options` and an optional `recommended` index into them, never beside `options`, `approve` or `deny`,
  and optional `attachments` and `scope`, below), `slack` (`to`, `text`, optional `attachments`),
  `ship` (`sha`, `prs` of `{number, title, url?}`, where `bun run ask new` and `edit` fill each `url` into the factory's repo, `factory.repo` else the checkout's origin, so the card links each PR),
  `ticket` (`team`, `title`, `body`), `delete` (`what`, `why`), `schema` (`shape`), `budget` (`amount`, `why`), `grant` (`permission`, `why`, below), `guard` (`key`, `scope`, optional `value`, `why`, below), `own` (`key`, `own`, `scope`, `why`, below), `secret` (`key`, `sink`) or `reveal` (`service`, `why`); a decision with none is refused.
  A `delete`'s `what` names each target by its full path, the one `playground rm --decision` matches, so one approval is enough: `bun run ask new` refuses a short name that is there (a relative or `~` path, a worktree's bare folder name), naming the full path to write, unless that full path stands beside it (`deleteRefusal` in `api/hono/src/lib/dashboard/delete-targets.ts`).
  An `ask`'s `attachments`, a draft's, a `slack` decision's and a read-only update's, are up to 20 files on this Mac, each `{src, kind?, label?, group?}`: `src` an absolute path, never a URL; `kind` one of `code`, `doc`, `html`, `image` or `pdf`,
  read from the extension when left out (`KIND_OF_EXTENSION` in `api/hono/src/lib/dashboard/inbox-attachments.ts`); `label` `before` or `after`; `group` a one-line section heading.
  `bun run ask new` and `edit` fill each `{now}` in the item's text with the time they post at in the owner's zone (`clock.ownerZone`, `fillNow` in `api/hono/src/lib/dashboard/ask-clock.ts`), and refuse a `measured` or `now` time more than 2 minutes ahead of the clock (`futureNowTimes`), naming it;
  an ETA or a finish carries neither word and posts, and plan.json's reader refuses its own now-stamps the same way (`.agents/dashboard/apps.md`).
  `bun run ask edit <id|#iN>` (`editItem()`) takes the same JSON as `new` and replaces the item's `title` and `preview`, its files copied the same way, bumping `updatedAt` and `version`, so one card carries a progress to its end;
  an update edits until the owner presses Done or Dismiss or its poster resolves it, and an ask until it closes, answered, archived, put away with Later or replied to alike, an edit to one he replied to taking the reply off so it waits on him again, so a progress card is edited in place to its end;
  the card's own answer carries `seen`, the `updatedAt` it showed, which `answerItem` refuses once it no longer matches (`This item changed since you read it`), so Approve never lands on words the owner did not read;
  it refuses another session's item (its `from` differs), a change of `kind`, and a closed item: done or dismissed by the owner, settled, resolved, or closed by its poster's ack (`closed()`).
  `bun run ask new` checks every file first, then copies each into the attachments folder (`keepAttachments`, through `storeAttachment`: bytes sniffed, 10 MB a file, a week's retention), and the item keeps `{id, kind, name, label?, group?}`.
  It refuses, with one line naming the file, an unknown key, a relative path, a missing file, a file over the cap, and bytes that do not match the kind; it takes every kind (code, doc, html, image and pdf).
  `GET /api/v1/inbox/attachments/:id` serves a kept file behind `requireTrustedOrigin`, `requireLoopback` and the owner rung, so the web fetches it with its cookie into a blob URL (`useAttachment`), since an `<img>` sends no Origin.
  A 404 (a fixture stack's restart drops its files, or the week's sweep took one) settles as missing for the page's life, asked once and never retried, and the card shows Missing in the file's place, or a folded pair's before alone when its after is the one gone.
  Any other failure (another status, a lost connection) retries as every read does, then shows Did not load in the same place, or the pair's before alone when its after is the one that failed.
  With `?download` it saves the file under its item's title, the file's own name after it when the item carries several, with the stored file's extension (`attachmentDownloadName`), in `Content-Disposition`'s `filename*` (`fileNameOf` and `attachmentDisposition` in `api/hono/src/lib/download.ts`), a header CORS exposes,
  so the card's Download fetches it with the cookie and saves it under that name (`saveFrom` in `web/next/src/lib/download.ts`).
  The card shows its files under the text gap-3 below the words:
  a lone HTML page live at its full width through the viewer's own HTML view, links opening in a tab, never taking the focus, an `h-80` box with a floating bar in its corner holding Download, Open in new tab, Open in side panel (in the aside alone, an aside tab of its own) and Full screen (the viewer), each named in a tooltip (`LivePage`),
  a lone before/after pair at its full width with Before above After, each in an `h-48` box, the picture `object-contain` (`WideSide`, Up and Down a side), else in a four-by-four grid of squares gap-3 apart, up to sixteen thumbnails or fifteen and a `+N` tile (`AttachmentThumbs` in `web/next/src/components/dashboard/viewer/thumbnails.tsx`),
  a kind with no `Thumb` a titled tile, its icon over its name,
  each tile but `+N` and each side of a lone pair with its own Download on the glass in its top-right corner (`TileDownload`, named `Download <file>`), shown while the tile is hovered or holds focus and always on a touch screen, saving its file, a folded pair's both, as the viewer's does (`saveItem` in `viewer.tsx`),
  the grid a group whose Left and Right move focus a tile and Up and Down a row, Home and End to its ends (`focusTarget`), stepping the tiles alone (`button[data-tile]`), never a tile's Download;
  a click, Enter or Space on a page, a markdown document or a PDF in the aside opens it in an aside tab of its own (`opensInAside` in `web/next/src/lib/aside-docs.ts`), as a Pages row's click opens its page (`.agents/dashboard/dashboard.md`):
  the tab, focused as it opens, is one square after the session's tabs named for its file, whose pane draws the file through its kind's renderer below (`AsideDocsPane` in `web/next/src/components/dashboard/aside-docs.tsx`), a kept page through the HTML view below as a card's page is, fetched with the owner's cookie into a blob URL (`pageQuery`),
  in a bordered box with a floating bar in its corner holding Download, of the card's file or the kept page, Open in new tab for a page, an image or a PDF, Full screen (the viewer, `docItem` giving a kept page its own addresses) and Close, each named in a tooltip, the live page's look and size;
  opening a file whose tab is open focuses that tab and adds none (`openDoc`), and the tabs last for the page's life.
  A click, Enter or Space on any other file (a picture, a before/after pair, a code file) opens the viewer (`Viewer` in `viewer.tsx`), full screen over the page, its own colours dark whatever the theme, on a see-through stage, the stock Dialog overlay's dim and blur, the file edge to edge, on the stock Dialog and Carousel, in Slider mode:
  one file a slide, Left and Up back, Right and Down on, past either end wrapping to the other with a jump (`wrapStep`), a swipe, the ‹ › buttons, Esc or X to close, a jump in place of the slide where motion is reduced.
  One floating bar, the aside's own, holds ‹, `2 / 6`, ›, the file's name, Download (`Download` in `viewer.tsx`: the shown file, or both sides of a before/after pair as two files, which a browser may ask once to allow, a failed save showing a warning in its place),
  Open in new tab, Open in side panel when the viewer opened from the aside (`onSidePanel`) and X, each named in a tooltip, the kind read to a screen reader alone;
  it rises while the pointer is within 96px of the bottom edge or a key has focus in it, and on a touch screen a tap on the picture shows or hides it, while an HTML page or a PDF, whose frame keeps a tap to itself, keeps it up (`pinsBars`); a thin strip along the bottom edge brings it up over an HTML or PDF frame, which keeps the pointer's moves to itself.
  A Close of its own stays shown at the top-right corner, one square on a floating bar of the same look.
  Open in new tab opens an image or a PDF at full size in a browser tab as its blob (`OPENS_IN_TAB`, `tabHref`), on a pair the Before, whose id the folded item keeps, never code or an SVG, since a blob URL runs with the Dashboard's origin.
  A kept page opens at its own Previews address, and a card's page as a blob holding it in an `<iframe sandbox="allow-scripts">` from `srcdoc`, under the page policy and with no script of its own (`pageTab` in `web/next/src/lib/viewer.ts`), since its route answers the Dashboard's own fetch alone.
  Each kind's renderer is one line of `VIEWERS` in `registry.tsx`; a renderer that keeps its own pointer or keys marks itself `data-viewer-owns-pointer` or `data-viewer-owns-keys`, and hands the arrows back with `onEdge`.
  An item's image `attachments` labelled `before` and `after` in one `group`, or both with no `group`, show as one slide in the viewer and one split tile on the card (`foldPairs` in `web/next/src/lib/pictures.ts`).
  That slide has one row of buttons floating at the stage's top over the whole-stage picture, Before, Side, Slider and After, Side and Slider joined in the middle, 3.5rem clear of each side on a narrow screen so the viewer's top-right Close never covers After; the row and the Side divider keep Left and Right and hand Up and Down back with `onEdge` (`handBack`).
  Side, the first view, shows them side by side at a divider that drags from the centre; Slider stacks them under a drag slider (`role="slider"`, 5% a Left or Right press, Home and End to the ends, Up and Down handed back with `onEdge` for the slide before or after).
  Both use one 1px divider, the knob on the slider alone, Before on the left, and Before or After shows that picture alone; a picture zooms in at a click or Enter and pans on a drag, while a touch tap on it shows or hides the bars as on every kind and a tap on the slider or the bar's buttons acts on it alone (`web/next/src/components/dashboard/viewer/image.tsx`).
  Label a set of screenshots this way so the owner compares them.
  The kinds past `image` render in `web/next/src/components/dashboard/viewer/documents.tsx`.
  An `html` page comes only from the data folder, which holds `playground page`'s previews folder: `bun run ask` refuses any other path, its symlinks resolved first.
  The route serves it as plain text, as every kept text file; the viewer builds the page itself (`asViewerPage` in `web/next/src/lib/viewer.ts`):
  its fetch policy (`default-src 'none'`, inline script and styles, `data:` images and fonts) as a `<meta>` CSP ahead of its markup, since no header reaches a `srcdoc` page,
  and a script after it that posts Escape and a Left or Right the page left alone, read by `viewerFrameMessage`: one that changed nothing on the page by two frames on, so a deck that moves its slides without taking the key keeps it.
  The frame takes the focus once its page says it is ready, and again when its slide comes back, so the page's own arrows run it.
  It runs in an `<iframe sandbox="allow-scripts">` from `srcdoc` alone, since its blob is plain text, and its Open in new tab holds it in the same sandbox (`pageTab`).
  A link clicked in it opens in a browser tab of its own, http or https alone (`viewer: "link"`), and one to a place on the page scrolls there with no load.
  Since a policy reaches no navigation, each load is judged by whether its page posted `viewer: "ready"` (`frameLoad`): a page a script or a refresh sent the frame off to is put back once, then stopped on a notice, each request that took it off having left.
  A `doc` renders through `TranscriptMarkdown` and a `code` file as one fenced block named by its extension (`fenced`), both in a region that keeps Up and Down for scrolling;
  a `.diff` or `.patch` draws there as a patch view instead (`patch-view.tsx`, loaded through `next/dynamic` only when one opens), one block a changed file, split from 768px up and unified below, its lines wrapping, and as that fenced block when it holds no patch the view can read or the view throws; a `pdf` opens in the browser's own viewer in an unsandboxed frame.
  An `ask` whose title, text or labels have the owner quit, restart, close or stop something, in any form of the four verbs but a past form after after, since, because or while, a determiner and one word ("after the dashboard restarted"), carries `checked`,
  one line saying what the four checks of playbook's **ask** found (the ops jobs and their runtimes in the data folder's `ops/jobs.json`, the live processes under the target, the sessions in it, and the Dashboard's `/api/health`),
  `none` or what still depends on the target, and is refused without it,
  the refusal naming the checks; `checked` stays in the stored payload and the owner's card does not show it.
  A draft's is `{to, text, thread?, attachments?}`: `to` a short name ("a teammate's thread", "a teammate's DM").
  A draft with no `link`, one that carries `noLink` with why, is a public post's, which the owner posts on a social site or a public page, so it keeps to the **public** rule (`extensions/core/rules/public.md`).
  `bun run ask new` and `edit` refuse such a draft whose `text` holds what that rule keeps out, naming the kind and never the text: `publicDraftRefusal` in `api/hono/src/lib/dashboard/public-draft.ts` runs `scripts/hooks/public-draft.ts` on the `text` as a child (`scripts/hooks/README.md`, The public-draft check), and a draft with a `link` posts as before.
  Its `attachments`, such as an issue's before and after shots, show under its words as an ask's do, and while it is open its card reads `2 files · uploads on Send` under them when its `link` names a Slack conversation (`uploadsOn` in `web/next/src/lib/inbox.ts`).
  On Send, the dashboard shares those files into that link's channel and thread before the words reach the poster (`filesToUpload` in `inbox.ts`, through `playground dm upload <item id>`, messages.md), and the card's result line counts them (`Sent · 2 files shared`); the poster still gets the words alone (`answerPayload`).
  A Linear draft's files, a draft's with no Slack link, and one whose link's thread part does not parse (`slackPlace`) stay on the card; a link that names no thread shares them at its conversation's top level.
  A `slack` decision's `attachments` show under its message the same way, its card reading `uploads on Approve`, and Approve or Edit shares them the same way.
  A share Slack refuses, or a file gone from the attachments folder, fails the send before anything is typed (`UPLOAD_FAILED`, `Send failed: The files did not upload to Slack: <why>`), which Retry shares again;
  a send that shared its files keeps their count in its answer (`uploaded`), so a Retry after the words failed to type shares none twice, and a fixture or test stack shares nothing and counts 0, which its line leaves out.
  Once the files have gone, words that then fail unconfirmed (`INTERRUPTED`, `ERROR`) or go to the dispatcher by relay leave the files in the thread with no reply yet.
  A draft, and a `slack` decision, carries `thread` whenever the reply answers a Slack conversation, so a Slack draft shows a short summary of who said what at the other end, with the drafted reply below.
  It holds 1 to 12 `{who, said}`, oldest first: `who` the display name as Slack shows it (a first name, never a raw token), `said` the gist of that message in one line of plain STE100 words.
  The card shows them as So far above the words to send, a draft's under Your message, each gist rendered through `TranscriptMarkdown card`; `bun run ask example slack` prints a `slack` decision with its `thread` filled.
  Which Slack messages post directly (a developer's) and which come here as a draft (anyone else's) is playbook's **ask** ([rules/ask.md](../../extensions/core/rules/ask.md)).
  Before drafting a reply to a person's message, read that DM or channel from that message on, its thread and the top level both, and draft only while the owner has not answered it already (twice on 23 Oct a reply was drafted after the owner had replied, and both drafts were discarded); `bun run ask new` reminds you once when a draft's `link` is a message.
  What that read found goes in the item's `thread`, a line for each message that leads up to the reply.
  A draft, and a `slack`, `ship` or `ticket` decision, also names where it will land, upfront, not after the send: `link`, the https URL of the Slack thread, channel or DM it posts in (a DM's conversation found or opened first, read-only where it already exists), the canary compare or the pull request,
  or the Linear team or project; or, with no place yet (a brand-new DM nobody can open), `noLink`, one line saying why.
  One of the two is required and both are refused; `accept`, `apps`, `ask`, `budget`, `delete`, `grant`, `guard`, `own`, `reveal`, `schema` and `secret` take neither.
  A draft that asks or nudges a named person goes to that person's DM, never a public comment: its `to` names the DM and its `link` is that DM conversation, never a thread reply or a PR comment; a channel ask, such as the one in an org's review channel, stays in its channel.
  Its card's place line, above its title, shows the link by name (Open thread for a draft or a Slack link, `owner/repo#N`, `owner/repo compare`, a Linear ID) or `No link: <why>` (`upfrontLink` in `web/next/src/lib/inbox.ts`), until the poster's ack links where it landed.
  An `ask`'s or an update's optional `scope` names whose work it is, unlike a `guard`'s or an `own`'s `scope`, the settings scope its write lands in.
  It is `factory` (`FACTORY_SCOPE` in `packages/config/src/inbox.ts`) for the factory's own and an org's name for an org's: ops-wa sends only a `factory` card to WhatsApp, and a card with no scope stays in the Inbox (ADR 0024).
  An update's is `{outcome, link?, text?, attachments?, scope?}`, its outcome one of `alert`, `decision`, `finding`, `merged` or `shipped`, so progress or an ETA is no outcome of its own: a session carries its progress in the one item it keeps editing with `bun run ask edit`, never a new item a step, which keeps the Inbox one card a thread.
  An update with `text` or `attachments`, an ask's two fields, is the read-only card: it shows them as an ask's card does, with no Approve, Deny or On Approve line, for something the owner looks at and answers nothing to, such as a table or a preview.
  Unknown keys are refused, and so is an archives-style Slack link (`<workspace>.slack.com/archives/...`) anywhere in an item, a `--link`, a `--label` or a `--note`, naming the command `slack.linkConverter` holds, which rewrites a link to its app form, when that setting is set.
  A raw Slack mention token anywhere in an item (`<@U...>`, `<!subteam^...>`, `<!here>`, `<!channel>`, `<!everyone>`, `<#C...>`) is refused too, since a raw token shows the reader an ID, not who is tagged: mentions read as names (@teammate), and the poster resolves each ID by name when it posts.
  A draft, or a `slack` decision, speaking as we, us, our, ours or ourselves is refused too: it speaks in the owner's voice, first person singular, code, quoted words and links aside, and the all-caps `US` and a hyphenated name (`us-east-1`) passing, a bare URL or Slack's `<url|label>` form being an address, not a voice.
  `status` reads `open` until the owner answers or its poster settles it (`done`, answer `{at, by, choice: "settled", link?, linkLabel?, note?}`, its card reading Decided by the poster with no buttons, nothing delivered, and one the owner answered refused,
  a reply included once its poster acked it, since a settle replaces the whole answer; a reply not yet acked still settles), then `approved` (Approve, with `answer.option`, the go row's index from 0, which a lettered decision's Approve requires and its Edit has none of, or `answer.options`, one index per question a multi-question ask's Approve requires, or Edit with `answer.editedText`), `denied`,
  `sent` or `drafted` (Draft; each with `editedText` when the owner changed the draft), `discarded`, `cleared` (a decision's or draft's set-aside, by a Dismiss while it waited or the old `clear`, neither yes nor no), or `provided` (a secret ask's Submit, below); an update is `done` from the start, read once `readAt` is set, and its answer is `{dismissedAt}` once the owner dismisses it.
  Delivery is `pending`, then `delivered` (`via: "session"` with `to`, the session that took it), `queued` (Claude Code holds it, above) or `failed` with the adapter's code; when it fails, or to collect the answer without waiting, the poster polls `playground ask get <id> --ack` until `status` is not `open`, and `--ack` records `{at, status: "delivered", via: "cli"}` (`readAnswer`),
  the first delivery recorded standing.
  A go (Approve, Edit, Send, Draft) closes only once carried out, with where it landed, whatever its kind of link: `playground ask ack <id> --link <https url>` (the Slack message, the pull request, issue or comment,
  the Linear ticket or comment) or `--no-link "<why>"` for a go with no page (a budget, an accept, an apps change, a grant, a guard setting, an own account change) or a Draft Slack refused (`draft_already_exists`), which `ack` refuses to go without, and one way alone: `--no-link` fits a go with no link recorded, and `--link` one not closed with no link;
  a deny, a clear, a discard or a provided secret closes when read, by `get --ack` or a bare `ack`.
  Closing stamps `answer.ackedAt`, the first close's time, even after a delivery to the session, and records `answer.link` or `answer.noLink`; until then a go's card names its pick alone under a blue light;
  an accept, an apps change, a guard setting or an own account change the Dashboard ran, or a grant whose pane failed to open, reads its result after the pick, and a grant whose pane opened reads that line (below),
  and once closed with no link it adds `No link: <why>`, but for a Draft, which reads, gray, `Draft not saved: <why>`.
  `bun run ask stale [--minutes 15] [--since <iso>]` prints one line for each answer of the owner's (not a settle) given since `--since` (default 24 hours ago) and at least `--minutes` ago with no `ackedAt` (a go not closed with its link or why, anything else not read), its delivery pending, failed or typed into the session alike, but for a failed one the owner dismissed,
  which the owner chose not to send (`staleItems`; an answer delivered before acks were stamped, `ACKS_STAMPED_FROM`, is not listed, since it may have been acked with no stamp, while one never delivered still is, and a go delivered before then, read through bun run ask or typed into its session, reads as closed):
  ops-sweep reminds each live poster on it once, then at most every 4 hours, and a lead hears of a poster that is down (playbook's Sweep).
- A `secret` ask asks the owner for a value (a client secret, an API key) that goes straight to one sink and is kept nowhere: no row, log line, transcript, response, error or argv holds it.
  Its `key` is the environment variable's name and its `sink` one of the allowlist in code, `secretSinkSchema` in `api/hono/src/lib/dashboard/inbox.ts`, `{type: "vercel", project, scope, environments}`, each environment of `development`, `preview` and `production` named once, or `{type: "keychain", item}`,
  one of this Mac's Keychain items `keychainSpec` in `api/hono/src/lib/keychain-items.ts` allows, always as the Mac's signed-in user: a typed one by name, `slack` (the Slack user token the Slack extension reads) or `yard` (the Yard token `playground yard` and the local Dashboard read), whose value must take its shape (`KEYCHAIN_ITEMS`),
  or any other of Playground's own by its full service, `playground-` then lower-case letters, digits and hyphens (`PLAYGROUND_SERVICE`), whose value is 1 to 4096 printable characters with no quote, backslash or line break and no space at either end; every other service is refused, so no card names a browser's or the login keychain's items.
  Its card shows what Submit does, a masked field and Submit, Enter submitting too, then the comment box, whose words go through Reply alone, never with Submit, and Reply refuses words equal to what the field holds (`commentRefused` in `web/next/src/lib/inbox.ts`), so a value still in the field never reaches a transcript through Reply; Later, Archive and Dismiss stay, since none carries a value.
  Submit posts `{value, seen}`, the value trimmed of its edge whitespace (a pasted newline), to `POST /api/v1/inbox/:id/secret`, which `provideSecret()` claims in one write that holds only while the item is open at the version read, so the sink runs once, then hands the value on stdin to `vercel env add <key> --environment <env> --project <project> --scope <scope> --yes`,
  once an environment in order,
  from the temp folder with its output dropped and only `HOME`, `PATH`, the proxy and CA variables and `VERCEL_*` in its environment (`spawnSink` in `api/hono/src/lib/dashboard/secret-sink.ts`, stopped after 60 seconds).
  A keychain sink instead hands the value to `keychainItem(<item>).write` (`api/hono/src/lib/keychain.ts`), which checks it against the item's shape and writes it through `security -i` on stdin, so no argv holds it; its one result is `{environment: "Keychain", exitCode, line}`, `line` reading `saved` or the refusal's first line with the value cut out.
  Only a stack that reads the live machine runs the sink; a fixture or test stack runs nothing and records exit 0 (`runSink`, `saveToKeychain`).
  The agent sign-in's account is refused with a 403 after the owner rung (`refuseAgent` in `api/hono/src/middlewares/dashboard.ts`), since it holds the owner rung, so only the owner's own click submits a value.
  The item turns `provided`, its answer `{at, choice: "provided", results: [{environment, exitCode, line?}]}` (`exitCode` null once stopped by a signal, 127 when `vercel` could not start), and its poster gets the `submit` verb with each environment's result and the `playground ask get --ack` that closes it, which `bun run ask stale` chases until it does.
  The card reads `Provided` and each environment's mark, `<env> ✓`, or `<env> ✗` with its result's `line` (its exit status when it gave none), green once every environment took it, red while any did not, whether or not its poster was told;
  a value the sink refused takes a new ask, and so does one whose card still reads sending after the sink's minute an environment, since the API restarted mid-run and no exit status came back.
  A telling that failed leaves that colour as it is and draws `Not told to <taker> yet: <reason>` muted under the result (`deliveryNote`), with a Retry that types the same line again and runs no sink (`retryDelivery`).
  Until it is told or dismissed it still counts as failed to send and shows open (`needsYou`, `inboxSummary`), so its Retry stays in view.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Client secret for the web app",
   "preview": {"type": "secret", "key": "GITHUB_CLIENT_SECRET",
               "sink": {"type": "vercel", "project": "web-app", "scope": "acme",
                        "environments": ["production", "preview", "development"]}}}
  EOF
  ```

- A `reveal` card shows the owner a value already in this Mac's Keychain (a key to paste into another app), on the owner's click alone: no row, log line, transcript, delivery, error or argv holds it.
  Its `service` names the item in full, a `playground-` service as a keychain sink takes it (above), and `why` says what the owner needs it for; the card shows both, so the owner sees which item it reads.
  While the card is open and not archived, it shows a masked value with Show and Copy (`RevealField` in `web/next/src/components/dashboard/inbox.tsx`): each posts to `POST /api/v1/inbox/:id/reveal`, which `revealSecret()` answers with `{value}` in that one response, `Cache-Control: no-store`, and writes nothing.
  Show draws the value until Hide, the card folding or 30 seconds (`REVEAL_SHOWN_MS`); Copy puts it on the clipboard and never draws it.
  The route refuses a closed, dismissed or archived card with a 409, so an old card reads nothing, and the agent sign-in's account with a 403 (`refuseAgent`); it is a POST, so the relay, which carries GETs on `RELAY_GETS` alone, never carries it.
  Only a stack that reads the live machine runs `security find-generic-password -w`, the value on its stdout; a fixture or test stack shows `FIXTURE_REVEAL`, made up (`readFromKeychain` in `api/hono/src/lib/dashboard/secret-sink.ts`).
  Its choices are `Done, I have it` and `I do not need it`, so its poster hears which, and never the value; Edit is refused, since neither takes words.
  A reply or an answer's note on it that holds the value, a Copy pasted into its own comment box, is refused before anything is sent (`holdsRevealed` reads the item again for `answerItem` and `replyItem`, and matches a value of 8 or more characters, `REVEAL_MATCH_MIN`, since a shorter one would turn up in most words), and its Reply stays in that box, never the chat's composer.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "The GLM key, for the new Mac",
   "preview": {"type": "reveal", "service": "playground-glm", "why": "Paste it into the new Mac's GLM setup"}}
  EOF
  ```

- An `accept` decision asks the owner to accept an extension proposal no 5 has accepted (`web/next/content/docs/extensions.mdx`'s Review), since a 5 from another session accepts it itself (`judgeItem` in `packages/settings/src/items.ts`) with no card.
  It is one of the five decisions whose Approve the Dashboard carries out itself, with an `apps` change, a `grant`, a `guard` setting and an `own` account change (below), since an accept is the owner's own act and the CLI refuses one from a session with a role.
  Its `scope`, `kind` and `key` name the proposal in the store's own patterns, none able to start as a flag; its `rev` (7 to 40 hex) is the proposal's head the poster read, so a proposal written since is refused with a 409 (`acceptSchema` in `api/hono/src/lib/dashboard/inbox.ts`); `why` says why to accept it.
  A set the owner reads as one change is one card: `more` lists 1 to 20 further proposals, each with its own `scope`, `kind`, `key` and `rev` by the same rules, accepted after the first in the order written, so a proposal that needs another lands after it.
  Its card reads `On Approve, the dashboard accepts the proposed <kind> <key> in <scope>, as it reads at <rev>.` and the why, or with `more` one numbered line a proposal, in order, and an Approve of `Accept the <kind> <key> and N more`; Edit is refused, so the words approved are the words posted.
  Approve is claimed in `answerItem`'s one versioned write, so a double click runs once, then runs `ext accept <scope> <kind> <key> <rev> --reason "the owner approved it in the Inbox (#iN)"` for each proposal in order through `runCli()` (`api/hono/src/lib/store/extensions.ts`):
  one fixed argv a proposal (`acceptArgs`), no shell, no `PLAYGROUND_ROLE`, against the stack's data folder, a fixture stack's own.
  A list stops at its first failed accept and leaves the rest untried (`acceptAll`).
  The answer keeps `accepted: {exitCode, line}`: for one proposal the CLI's first line or its error; for a list `accepted <kind> <key> in <scope>, …`, or on a failure the ones accepted, the failed one with its reason, then `not tried:` and the rest.
  The card reads `Accepted: <line>` green or `Accept failed (exit N): <line>` red, and the poster, or the dispatcher in an ended poster's place, is typed that result with nothing left to carry out, closing it with `playground ask ack #iN --no-link "<why>"`.
  Deny, Archive and Dismiss run nothing; a failed accept takes a new decision for the proposals still unaccepted, each at its current rev.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Accept the end-of-day skill in acme?",
   "preview": {"type": "accept", "scope": "acme", "kind": "skill", "key": "end-of-day",
               "rev": "3f9a2c1d", "why": "Scored 4 by two reviewers; it reads the day's merges"}}
  EOF
  ```

  A set of proposals, accepted in the order `more` lists them after the first:

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Accept the handover set in acme?",
   "preview": {"type": "accept", "scope": "acme", "kind": "doc", "key": "templates", "rev": "4a0b1c2d",
               "more": [{"scope": "acme", "kind": "skill", "key": "handover", "rev": "5b1c2d3e"},
                        {"scope": "acme", "kind": "rule", "key": "quiet-hours", "rev": "6c2d3e4f"}],
               "why": "The skill reads the templates, and the rule names the skill"}}
  EOF
  ```

- An `apps` decision asks the owner to add an app to the owner's own apps, the `desktop-owner-apps` guard list no-desktop-owner-app keeps agent-desktop away from, or to remove one, since that list changes only by the owner's act (`scripts/hooks/README.md`'s no-desktop-owner-app).
  Its `app` is the app's name, a letter or digit first, so none starts as a flag or names a path, `change` is `add` or `remove`, and `why` says why (`appsSchema` in `api/hono/src/lib/dashboard/inbox.ts`); Edit is refused.
  Approve is claimed as an accept's is, and runs one at a time in the API process, so two overlapping Approves both land.
  It reads the login scope's own list as accepted, adds or removes the app matched as the hook matches it (`appsChange`),
  and runs `ext put <login> list desktop-owner-apps - --reason "the owner approved it in the Inbox (#iN)"` with the new list on its stdin (`appsArgs`, `ownerApps` in `api/hono/src/lib/store/extensions.ts`), no shell, no `PLAYGROUND_ROLE`.
  An app already on the list, one to remove that the login's list lacks, or a list that is not names writes nothing.
  The answer keeps `listed: {exitCode, line}`, and the card reads `Your apps: <line>` green or `Apps change failed (exit N): <line>` red; the poster closes it with `playground ask ack #iN --no-link "<why>"`, and after a failed one, whose list stays as it was, tells its lead.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Keep agent-desktop away from Notes?",
   "preview": {"type": "apps", "app": "Notes", "change": "add", "why": "It holds your own notes"}}
  EOF
  ```

- A `grant` decision asks the owner to grant agent-desktop a macOS permission, `permission` `accessibility` or `screen-recording`, and `why` (`grantSchema`); Edit is refused.
  Its Approve runs `/usr/bin/open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility` (or `?Privacy_ScreenCapture`), one fixed argv (`grantArgv`, run by `api/hono/src/lib/dashboard/run-argv.ts`), which opens System Settings at that pane on this Mac for the owner to turn it on; a stack showing test data refuses it, opening nothing.
  The answer keeps `opened: {exitCode, line}`, and the poster rechecks the grant with `agent-desktop permissions` every 30 seconds for up to 5 minutes (after a pane that failed to open, it tells its lead instead), closes the item with what it reads and tells the session that stopped for it, since macOS grants the app that launches agent-desktop, which only the poster's own run reads;
  until then the card reads that it is being carried out.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Let agent-desktop see the screen?",
   "preview": {"type": "grant", "permission": "screen-recording",
               "why": "The simulator check takes a screenshot"}}
  EOF
  ```

- A `guard` decision asks the owner to set a guard setting, a key a guard reads to allow or deny a call, since no session can write one (`no-extensions-write` refuses it, `scripts/hooks/README.md`): any session posts the card, and only the owner's Approve writes the setting.
  Its `key` is one of `GUARD_SETTING_KEYS` (`packages/settings/src/guard-keys.ts`, which the hook's `GUARD_KEYS` matches), a registry job's `jobs.<name>` or an org's own job's `jobs.<camelName>` (a job the registry lacks), `scope` is the owner's login or an org (core changes by a pull request), `value` is what the key's schema takes,
  checked as it is posted (any job takes `{"enabled": true|false}` alone or `{"config": {...}}` alone, any object, since the job checks each of its config's fields itself, and an org's own job also a whole job row, which Approve's write then checks against that org's script folders and refuses at the login's scope or when another org already adds the job),
  or left out to take the setting back to its default, and `why` says why (`guardSchema` in `api/hono/src/lib/dashboard/inbox.ts`);
  Edit is refused.
  The card shows the key, the scope and the value as its JSON, exactly as Approve writes them.
  Approve takes `seen`, the `updatedAt` of the card the owner read, so an Approve with no `seen`, or one read before the poster's `bun run ask edit`, is refused and writes nothing.
  It is claimed as an accept's is, then writes the setting at its scope in the stack's own extensions, a fixture stack's own, through `setSetting` (or `resetSetting` for no value) in `@packages/settings`, its commit's reason `the owner approved it in the Inbox (#iN)`;
  a job's `enabled` or `config` goes over the row its scope holds, never the registry's fields, so a registry job keeps the registry's command and schedule (`settingsFor`'s merge, `.agents/dashboard/dashboard.md`'s Jobs),
  an org's own job's merged row is checked as a whole row is, and refused with `<key> has no row at <scope> to change` while its scope holds none,
  an org's own job's whole row replaces the row its scope holds, and a value its scope already holds writes nothing and reads `<key> at <scope> is already <value>, so nothing changed`.
  The answer keeps `set: {exitCode, line}`, and the card reads `Guard setting: <line>` green or `Guard setting failed (exit N): <line>` red; the poster closes it with `playground ask ack #iN --no-link "<why>"`, and after a failed one tells its lead.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Gate acme's Slack sends?",
   "preview": {"type": "guard", "key": "slack.gatedSends", "scope": "acme",
               "value": {"path": "<send path>", "selfDm": "D0EXAMPLE", "servers": ["<server>"]},
               "why": "Back acme's no-Slack-writes guard"}}
  EOF
  ```

- An `own` decision asks the owner to mark one Claude account in `usage.accounts` as the owner's own, or to unmark it, the flag Settings > Accounts' Own account switch sets: any session posts the card, and only the owner's Approve writes it.
  Its `key` is the account's email, `own` the flag Approve leaves it with, `scope` the owner's login or an org, and `why` says why (`ownSchema` in `api/hono/src/lib/dashboard/inbox.ts`);
  a key that names no Claude row in `usage.accounts` at that scope (a GLM row's label included) is refused as it is posted or edited, and Edit is refused.
  The card shows the email, the scope and the change, Own off to on or on to off.
  Approve takes `seen` as a guard setting's does, then reads the list, sets or drops `own` on that one row through `withOwn` (`@packages/config/accounts`), every other row and field as it was, and writes the list through `setSetting`, its reason `the owner approved it in the Inbox (#iN)`; a row already in the asked state writes nothing.
  The answer keeps `owned: {exitCode, line}`, the line naming the state Approve found, and the card reads `Own account: <line>` green or `Own account change failed (exit N): <line>` red, and Settings > Accounts reads its switch again (`ACCOUNTS_QUERY_KEY`); the poster closes it with `playground ask ack #iN --no-link "<why>"`.

  ```bash
  bun run ask new <<'EOF'
  {"from": "dispatcher", "title": "Mark pat@example.com as your own?",
   "preview": {"type": "own", "key": "pat@example.com", "own": true, "scope": "made-up-me",
               "why": "Spend the org's accounts before your own"}}
  EOF
  ```

- The ask's shape: an `ask` decision's text reads the way chat talks to the owner, in three parts, top to bottom:
  1. A picture of the point: a diff or code block for a code change, before and after pictures for a UI change (as `attachments` with the smart viewer), an ASCII flow in a code block for a plain decision.
     Keep each code or ASCII line within `ASK_CODE_COLUMNS` characters, the drawing width the card paragraph above names, whose source (`packages/config/src/inbox.ts`) gives the card width and character width it comes from; a `diff` block's lines may run longer, since the card wraps them.
     A wider drawing still posts and shrinks to 10px, then scrolls, so the limit is a writing guide.
     A note of one sentence on the point follows the picture, by the `plain-words` skill's owner style (`extensions/core/skills/plain-words/SKILL.md`).
  2. Short bullets, one fact each, an emoji as each one's marker.
  3. The options: for a true yes or no, one `options` row saying what Approve does, with `deny` beside it; for real alternatives, 2 to 5 rows, A to E, each a `label` and an optional `description`.
     The card shows them as its choices under the text, in place of its On Approve line.
     For several calls at once, a `questions` list in place of `options`: 2 to 20 questions, each its own 1 to 5 `options` and an optional `recommended` index, which the card asks one at a time and sends together.

  A factory session writes each item's words and pictures by the `to-inbox` skill (`extensions/core/skills/to-inbox/SKILL.md`), loaded before `bun run ask new`.
  A job of several steps leads with to-inbox's work status block, a read-only update its poster edits in place as each step lands (`extensions/core/skills/to-inbox/references/PROGRESS.md`).

  `bun run ask example code|decision|delete|questions|slack|ui` prints each worked example as an item to fill in, the asks below and the delete and slack decisions above.
  `bun run ask new` prints a hint on stderr, and posts the item all the same, when an ask's text runs past 300 characters with no list, code block or attachment, an ask labels no options,
  a line of an ask's or a read-only update's text outside a code block names a PR (a number after a `#` or after `PR`), a tracker ID (`ABC-123`) or a commit sha with no link on that line (an Inbox ref, `#iN`, needs none),
  or a code block other than a `diff` one in an ask's or a read-only update's text holds a line past `ASK_CODE_COLUMNS` (`shapeHints`).
  The four, as their card shows the text (`tests/api/hono/src/lib/dashboard/ask-shape.test.ts` holds this file to the templates):

  ````markdown
  ```diff
  - const limit = 100
  + const limit = rows.length
  ```

  The export fix is ready to port to staging and main.

  - 🐛 The export ends at 100 rows.
  - ✅ The fix runs on dev since 24 Oct, with no errors.
  - ↩️ One commit reverts it.
  - 🎯 It touches the export alone.
  ````

  Options: `Port the fix to staging, then main`; Deny: `Keep it on dev`.

  ````markdown
  ```
  web-api
     │ asks for a dry run
     ▼
  builder ──runs──▶ export job (dev)
     │
     ▼
  report to you
  ```

  A dry run of the export job waits on your yes.

  - 📨 The web-api session asks for a dry run of the export job.
  - 🧪 The run is on dev only and writes no rows.
  - ⏱️ It takes about 10 minutes.
  ````

  Options: `Take the request and run the dry run`; Deny: `Turn the request down`.

  The UI change's before and after pictures join the ask as `attachments` (absolute paths on this Mac, each with its `label` and `group`, which `bun run ask new` copies in), and its card shows them under this text, which opens on its note:

  ````markdown
  The Inbox card can show its pictures as one thumbnail row.

  - 🖼️ The Inbox card shows its pictures as a row of thumbnails.
  - 👆 A click opens the picture in the viewer.
  - 📱 The row scrolls sideways on a phone.
  - ↩️ One revert puts the old card back.
  - 🎯 It touches the Inbox card alone.
  ````

  Options: `Build the row as the after picture shows`; Deny: `Keep the card as it is`.

  The multi-question ask leads with its text, then asks each question in turn, one pick per question:

  ````markdown
  Two calls on the export fix, one for each.
  ````

  Where should the export fix land first?
  `Staging first` (recommended), `Straight to main`.
  When should it go out?
  `Now`, `After the next ship`.

- Threads group the owner's asks: a thread is one thing they asked about, followed up until it is done, and it is theirs, not a session's ([ADR 0013](../adr/0013-threads-are-the-owners-and-live-in-the-dashboards-database.md)).
  It is one table, `thread` (`packages/db/src/schema/thread.ts`), in the dashboard's local Postgres beside the transcripts: a transcript line joins a thread through `claude_entry.thread_id` and `thread_seq`, its place there, and an Inbox item through `inbox_item.thread_id`.
  Its shapes on the wire are the contract in `@packages/config/threads`, read and written through `api/hono/src/lib/dashboard/threads.ts`, and served by `GET /api/v1/threads?page=N`, `GET /api/v1/threads/:id/messages` and `PATCH /api/v1/threads/:id`, each behind the dashboard's guards and the owner rung.
  A page holds 5 open threads, pinned first with the newest pin on top, then `updatedAt` newest first, `id` breaking a tie, archived ones left out (`listThreads`); each carries `unread`, its lines someone else wrote (not `human` or `meta`) stamped after `lastReadAt`, every one while that is null, the count the thread view's Unread holds, and `firstMessageId`,
  the uuid of its lowest `thread_seq` line, the id the chat keys it by.
  A PATCH takes at least one of `archived`, `pinned` and `read`, each setting its time to now or clearing it (read false marks every line unread again), and `title`; it leaves `updatedAt` alone, which only the route that tags a line to a thread bumps, so a change keeps the thread's place.
  An id is 4 characters of `ID_ALPHABET` with at least one letter (`THREAD_ID`); any other is a 400.
  The GET is a read: a fixture stack's 7 made-up threads are written by `bun run ingest` once it has read the fixture's transcripts (`seedFixtureThreads`), only while `dashboardSource()` is the fixture, so they never reach the live dashboard's database.
- A thread's marker routes a line: a transcript line of kind `human`, `peer`, `prompt` or `assistant` whose text opens with `[thread:<id>]`, past the `[Image #n]` marks Claude Code puts first, belongs to that thread (`markerOf` in `@packages/config/threads`).
  It is ASCII and never a bare `#xxxx`, so it never reads as an Inbox id or a PR number.
  Ingest routes each marked line as it stores it (`routeMarked`, called from `applyChunk` in `api/hono/src/lib/sessions/ingest.ts`, in the chunk's own transaction): the line takes the thread's next `threadSeq` and bumps its `updatedAt`, through the same tag `routeMessage` uses, which locks the thread's row, keyed by the line's uuid in place of a quote.
  A marker naming no thread leaves the line untagged, and a tagged line never moves to another thread, a re-read's included.
  So the session's own reply routes too, once playbook's DISPATCH.md has it open with the marker, and so does a peer's report that opens with it.
  This is the dashboard's partial answer to the open question in ZeroSDK's decision that threads group a session's stored lines, a message "tagged with its thread on both sides":
  the receiver's side routes by the marker, while the sender's side is a tool call (`SendMessage`), which carries no thread, so that side stays open.
  Playground routes a line or an item to a thread by hand, when playbook's DISPATCH.md says, with the `bun run thread` CLI (`api/hono/src/bin/dashboard-thread.ts`) or `bun run ask new --thread <id>`, which proves its database as `bun run ask` does; run either in the live dashboard's checkout.

  ```bash
  bun run thread new "Rename the sidebar to Threads"   # prints the new thread's 4-character id, refusing a title past 200 characters
  bun run thread route <id> --quote "<opening words>"   # routes the newest untagged message (a person's, a peer's or a prompt, never the session's own reply, which its marker routes) of the dispatcher's session that starts with the quote; --session <id> names another session
  bun run thread title <id> "<title>"   # renames the thread, refusing a missing id, an empty title or one past 200 characters
  bun run thread list   # the open threads, pinned first, then newest: id, unread count, pinned, title
  ```

  A route tags the message's `claude_entry` row with the thread and the thread's next `threadSeq` (counting from 1 per thread) and bumps the thread's `updatedAt`, in one transaction that locks the thread's row, so two routes to one thread take their numbers in turn.
  The message reaches the database only once ingest brings it, so a route polls for up to `--wait` seconds (60 by default), then fails naming the quote.
- A thread's view (`ThreadView` in `web/next/src/components/dashboard/thread-view.tsx`, at `/dashboard/threads/<id>`) is a selective chat: its messages alone, by `threadSeq`, from `GET /api/v1/threads/:id/messages` (`threadMessages`), each through `TranscriptMessage` with its files as chips, an image a source line names among them,
  and a meta line left out, since a thread is not a chat that completes).
  It shows the first message under You asked when it is yours, then the ones someone else wrote stamped after `lastReadAt` under Unread, the count the sidebar shows, then the rest, your replies included, folded under Full history (`threadSections` in `web/next/src/lib/threads.ts`), and marks the thread read as it opens.
  It keeps the moment it opened and the `lastReadAt` it opened with, so Unread holds still while it is open and everything stamped after that moment shows unfolded at the foot, a reply sent from the view included.
  Back to chat in its header goes to `/dashboard`, and the browser's Back works, since the view is its own page.
  Its composer is the primary dispatcher's, with a draft of its own (`<dispatcher>#<id>`), and sends through the outbox with `threadId`.
  - Routing a sent message: `POST /api/v1/messages` refuses a `threadId` to any other session (400) or for a thread that does not exist (404), and delivers the text with the thread's marker put first (`withMarker`), so ingest routes it once it brings it, with no wait on its words.
    A message of files alone carries the marker before its `Attached:` line, and an empty one stays empty, for the delivery to refuse.
    A message that opens with `/` or `!` goes unmarked (`COMMAND_START`), so a skill's command still runs and any other command is still refused, and it routes nowhere; New thread opens no thread for it.
    The main chat is unchanged: a routed message stays in it in time order, and a routed one never moves to another thread.
    The outbox matches the message to its transcript line past the marker (`findDelivery` in `web/next/src/lib/outbox.ts`).
    The marker routes the message's line alone, so `threadMessages` names its image by the session's untagged source line of the same prompt (`sourceLines`).
    Until it is routed, a message sent from the view shows at its end as on its way (`pendingIn`), for up to 90 seconds; one that failed points to the full chat for Retry or Edit.
- The main chat's New thread toggle, which sent a message with `newThread: true` in place of `threadId` to start a thread, is off for now: the composer renders none, while `sendMessage` still takes `newThread`.
  The API opens a thread titled from the message's first line (`quoteOf`: up to a pasted path, at most 80 characters, `Attached:` for files alone; renamed later through the PATCH), sends the message with its marker, and names the thread under `threadId` in its answer.
  A new thread whose message was refused before typing is removed (`dropThread`), while one cut off as it typed stays, since the message may have gone, and the refusal names it under `threadId`, so the outbox's Retry sends to it; one left pasted and unsent in a herdr session's box stays too, and the outbox's own wait sends its retry there (messages.md).
  A retry that `deliver()` answers from its first try's row (`replayed`) drops the thread it opened and names none, since the first try's marker already routed the message.
- A leading marker reads as a chip in every chat, the main one and a thread's view alike: `TranscriptBubble` in `web/next/src/components/transcript-message.tsx` shows the thread's id as an outline badge that opens `/dashboard/threads/<id>`, and the words after it.
- On the hosted build the Inbox draws no answer, comment, secret field, reveal's Show or Copy, read tick or shelf button, shows a draft as text, sends nothing and marks nothing read, and the read-only line stands at its top, by stack.md's relay rule.

"use client"

import type { Worker } from "@api/hono"
import { RiAddLine, RiArrowUpLine, RiReplyLine } from "@remixicon/react"
import { useForm, useStore } from "@tanstack/react-form"
import { useQuery } from "@tanstack/react-query"
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react"
import type { CSSProperties, KeyboardEvent } from "react"

import { AttachmentChips, useAttachments } from "@/components/dashboard/attachments"
import { useDashboard } from "@/components/dashboard/dashboard"
import { ModePicker } from "@/components/dashboard/mode-picker"
import { ReadOnlyLine } from "@/components/dashboard/read-only-line"
import { SettingPicker } from "@/components/dashboard/setting-picker"
import { Hint } from "@/components/hint"
import { Badge } from "@/components/ui/badge"
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"
import { toast } from "@/components/ui/toast"
import { useYardWrites } from "@/hooks/use-yard-writes"
import { chatLabel } from "@/lib/agent-label"
import { apiClient, unwrap } from "@/lib/api/client"
import { caretPoint } from "@/lib/caret"
import { config } from "@/lib/config"
import { isPrimary } from "@/lib/dashboard"
import { draftSaver, readDrafts, takeHanded } from "@/lib/drafts"
import { itemTag, useInbox } from "@/lib/inbox"
import { isLoginCommand, LOGIN_HINT } from "@/lib/login-expired"
import { comparable, submittable } from "@/lib/outbox"
import { insertPaste } from "@/lib/paste"
import { markInserted, watchPastes } from "@/lib/paste-log"
import { setTypedReply, typedReply } from "@/lib/reply"
import { localLoadLine } from "@/lib/session-setting"
import { matchSkills, offersSkills, pickSkill, slashToken } from "@/lib/skill-menu"

const COARSE = "(pointer: coarse)"

type EnterKey = {
  ctrlKey: boolean
  isComposing: boolean
  key: string
  keyCode: number
  metaKey: boolean
  shiftKey: boolean
}

// Enter sends and Shift+Enter adds a line; with `enterAddsLine` (a touch keyboard, which has no Shift) Enter adds a line and only Cmd or Ctrl+Enter sends. Safari reports the Enter that commits an IME candidate with isComposing false but keyCode 229.
export function sendsOnEnter(event: EnterKey, enterAddsLine = false) {
  if (event.key !== "Enter" || event.shiftKey) return false
  if (event.isComposing || event.keyCode === 229) return false
  return !enterAddsLine || event.metaKey || event.ctrlKey
}

// The box's id, so a pending bubble's Unsend, Dismiss or Retry can hand focus back to it once the button is gone. Playground's own box keeps the bare id; any other box takes its session's name and thread after it, so two boxes on one page never share an id.
export const COMPOSER_ID = "composer"
export const composerId = (
  worker: Pick<Worker, "name" | "role">,
  dispatcher: string | null,
  threadId?: string,
): string =>
  !threadId && isPrimary(worker, dispatcher)
    ? COMPOSER_ID
    : [COMPOSER_ID, worker.name, threadId].filter(Boolean).join("-")

// A touch keyboard has no Shift, so where the pointer is coarse Enter adds a line and the button sends; Cmd or Ctrl+Enter sends everywhere, an iPad's hardware keyboard included.
const onTouch = () => window.matchMedia(COARSE).matches

const subscribeToPointer = (onChange: () => void) => {
  const query = window.matchMedia(COARSE)
  query.addEventListener("change", onChange)
  return () => query.removeEventListener("change", onChange)
}

// The skills a session may run, the list its message's leading / is checked against; they change only when a skill is added or removed.
const useSkills = (sessionId: string | null) =>
  useQuery({
    enabled: sessionId !== null,
    queryFn: async () => {
      const { data, error } = await unwrap(
        apiClient.v1.workers[":sessionId"].skills.$get({ param: { sessionId: sessionId ?? "" } }),
      )
      if (error) throw new Error(error.message)
      return data
    },
    queryKey: ["skills", sessionId],
    staleTime: 60_000,
  })

// How far above the /'s line the menu opens.
const MENU_GAP = 4

// Says something to a session as the owner: typed into its own terminal as if the owner typed it there, or for the session the dashboard hosts, put on its input; its reply arrives in the steps above, from the transcript. Phase 2a: either dispatcher, the assistant, and the session the dashboard hosts on the Agent SDK. Files come with a message by the attach button, a paste or a drop: each uploads at once and shows as a chip above the box, and the message carries their paths for the session to Read. What is typed and attached stays as the session's draft until it is sent. Sending hands the message to the dashboard's outbox and clears the box and the draft at once, so nothing waits on the request: the message shows in the stream as a pending bubble, and while more than one is on its way the chat's Checkpoint bar above the box counts them. It is AI Elements' Prompt Input, an InputGroup in a form: the reply chip and files above the box, which grows with what is typed up to 40% of the view and scrolls past that, then attach, the mode menu and send, whose tooltip holds the key hint.
// The hosted build's chat has a composer only in a browser that keeps a paired key, whose send the relay carries; elsewhere there it shows the one read-only line in the box's place.
export function Composer(props: { threadId?: string; worker: Worker }) {
  const writes = useYardWrites()
  return writes.send ? <WritableComposer {...props} /> : <ReadOnlyLine className="mb-2 py-2" />
}

function WritableComposer({ threadId, worker }: { threadId?: string; worker: Worker }) {
  const onPicker = worker.light === "needs-you"
  const { allowed, approvals, dispatcher, outbox } = useDashboard()
  // The session is shown by its label as its chat names it (chatLabel: Message Alpha); the message still goes to its raw name.
  const label = chatLabel(worker, dispatcher)
  // the main chat of the primary dispatcher, the one session a thread's messages go to, could open a thread with its next message; New thread is off for now, so nothing sets newThread
  const opensThreads = !threadId && worker.name === dispatcher
  const [newThread, setNewThread] = useState(false)
  const startsThread = newThread && opensThreads
  const boxName = threadId
    ? `Reply to ${label} in this thread`
    : startsThread
      ? `Start a thread with ${label}`
      : `Message ${label}`
  const touch = useSyncExternalStore(subscribeToPointer, onTouch, () => false)
  const hint = touch
    ? "Enter adds a line, the button sends"
    : "Enter sends, Shift+Enter adds a line"
  // An inbox item this message answers, named in the words as re #iN; Playground's own box alone answers one, as the Inbox is his.
  const id = composerId(worker, dispatcher, threadId)
  const main = id === COMPOSER_ID
  const items = useInbox(allowed).data?.items
  const box = useRef<HTMLTextAreaElement>(null)
  // What was typed here and not sent, kept per session in this browser, so leaving the chat or reloading the tab loses nothing.
  // a thread's view keeps its own draft, so words typed for the thread never send from the full chat unrouted
  const keep = threadId ? `${worker.name}#${threadId}` : worker.name
  const [saved] = useState(() => readDrafts()[keep])
  const [save] = useState(() => draftSaver(keep, saved))
  const attachments = useAttachments(keep, saved?.attachments)
  // held still, since the form resets its words to new defaults on any render while untouched
  const [defaultValues] = useState(() => ({ text: saved?.text ?? "" }))

  // the session's skills, for the / menu below
  const skills = useSkills(offersSkills(worker) ? worker.sessionId : null).data ?? []

  const form = useForm({
    defaultValues,
    onSubmit: ({ formApi, value }) => {
      // a click or tap on Send leaves focus on the button, where a dictation app's next Cmd+V lands nowhere, so focus goes back to the box first, on a refused send too
      box.current?.focus()
      // judged on what the send would carry, after the backslash drop
      const words = submittable(value.text)
      if (!words.trim() && !attachments.chips.length) return
      // a drop that leaves a backslash the typing would keep (the ends are trimmed, so x\ \ types as x\) would sit unsent all the same, and only he can reword it
      if (comparable(words).endsWith("\\") && !attachments.chips.length) {
        toast.add({
          title: "A message ending in a backslash would not send: drop it and send again",
          type: "info",
        })
        return
      }
      // /login would land on whatever prompt the session shows; an account is added in the app instead
      if (isLoginCommand(words)) {
        toast.add({ title: LOGIN_HINT, type: "info" })
        return
      }
      // A send carries only uploaded files, so it waits for the rest rather than leaving them behind.
      if (!attachments.ready) {
        toast.add({
          title: attachments.failed
            ? "A file did not upload: retry or remove it"
            : "Wait for the files to finish uploading",
          type: "info",
        })
        return
      }
      outbox.send(worker.name, {
        attachments: attachments.refs,
        ...(startsThread ? { newThread: true } : {}),
        text: words,
        threadId,
      })
      formApi.reset({ text: "" }, { keepDefaultValues: true })
      setNewThread(false)
      attachments.clear()
    },
  })

  const text = useStore(form.store, (state) => state.values.text)

  // The / menu: the session's skills by name, filtered by what follows a / at the caret; a pick puts the skill first in the message. Escape or leaving the box closes it until the / or its letters change.
  const [caret, setCaret] = useState(0)
  const [closed, setClosed] = useState<string | null>(null)
  const [active, setActive] = useState("")
  const token = skills.length ? slashToken(text, caret) : null
  const matches = token ? matchSkills(skills, token.query) : []
  const menuKey = token ? `${token.start}:${token.query}` : null
  const menuOpen = matches.length > 0 && menuKey !== closed
  const selected = matches.includes(active) ? active : (matches[0] ?? "")
  const menu = useRef<HTMLDivElement>(null)
  // Where the menu opens on a wide screen, at the / just typed: its bottom just above the /'s line, its left at the /, both from the field's own box; a phone's menu spans the box instead.
  const [place, setPlace] = useState({ bottom: 0, left: 0 })
  const slashAt = token?.start ?? null
  useLayoutEffect(() => {
    const field = menu.current?.parentElement
    const area = box.current
    if (!menuOpen || slashAt === null || !field || !area) return
    const point = caretPoint(area, slashAt)
    const outer = field.getBoundingClientRect()
    const inner = area.getBoundingClientRect()
    setPlace({
      bottom: outer.bottom - inner.top - point.top + MENU_GAP,
      left: inner.left - outer.left + point.left,
    })
  }, [menuOpen, slashAt, text])
  // as wide as the longest name, in the menu's own mono font at its rows' size, with room for its padding and an item's check, never wider than the box
  const longest = Math.max(0, ...skills.map((name) => name.length))
  const menuWidth = `clamp(10rem, ${longest + 1}ch + 3.5rem, 20rem)`
  useEffect(() => {
    if (!menuKey) setClosed(null)
  }, [menuKey])
  // a menu opened again starts on its first match, not the skill highlighted last time
  useEffect(() => {
    if (!menuOpen) setActive("")
  }, [menuOpen])
  // cmdk gives its list and items ids of its own, so the box names them for a screen reader once they are drawn
  const [menuIds, setMenuIds] = useState<{ item?: string; list?: string }>({})
  useEffect(() => {
    const list = menu.current?.querySelector("[cmdk-list]")
    const item = list?.querySelector(`[cmdk-item][data-value="${CSS.escape(selected)}"]`)
    item?.scrollIntoView({ block: "nearest" })
    setMenuIds({ item: item?.id, list: list?.id })
  }, [menuOpen, selected])
  const pick = (name: string) => {
    if (!token) return
    const next = pickSkill(text, token, name, skills)
    form.setFieldValue("text", next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret))
  }
  const onMenuKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // Safari reports the Enter that commits an IME candidate with isComposing false but keyCode 229, as sendsOnEnter says
    if (!menuOpen || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
      return false
    const step = { ArrowDown: 1, ArrowUp: -1 }[event.key]
    if (step) {
      const at = matches.indexOf(selected)
      setActive(matches[(at + step + matches.length) % matches.length] ?? "")
    } else if (event.key === "Enter" && !event.shiftKey) pick(selected)
    else if (event.key === "Escape") setClosed(menuKey)
    else return false
    event.preventDefault()
    return true
  }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (onMenuKey(event)) return
    const { ctrlKey, key, metaKey, nativeEvent, shiftKey } = event
    const key229 = { isComposing: nativeEvent.isComposing, keyCode: nativeEvent.keyCode }
    if (!sendsOnEnter({ ctrlKey, key, metaKey, shiftKey, ...key229 }, touch)) return
    event.preventDefault()
    event.currentTarget.form?.requestSubmit()
  }
  const reply = main ? typedReply(text, items ?? []) : null
  const loadLine = localLoadLine(worker.localLoad)
  // the list marks the item the words name
  const typedRef = reply?.ref
  const typedTitle = reply?.title
  useEffect(() => {
    if (!main) return
    setTypedReply(
      typedRef === undefined || typedTitle === undefined
        ? null
        : { ref: typedRef, title: typedTitle },
    )
  }, [main, typedRef, typedTitle])
  useEffect(() => (main ? () => setTypedReply(null) : undefined), [main])
  const { refs } = attachments
  useEffect(() => save({ attachments: refs, text }), [refs, save, text])
  // every Cmd+V and paste on the page, and each insert into the box but plain typing, goes to the browser's paste log (lib/paste-log.ts), lengths only, and a miss to this machine's API
  useEffect(() => watchPastes(() => box.current), [])

  // A failed message's Edit puts its text and files back here to fix and send again, after anything already there, and an Inbox card's Reply puts re #iN: before it, each taken once so coming back to the page does not put it back again, with focus in the box and the caret at the end; a thread's box beside the session's own leaves it to that one.
  const { clearDraft, draft } = outbox
  const { restore } = attachments
  const taken = useRef<typeof draft>(null)
  useEffect(() => {
    if (threadId) return
    const text = takeHanded(form.getFieldValue("text"), draft, worker.name, taken.current)
    if (text === null || !draft) return
    taken.current = draft
    form.setFieldValue("text", text)
    restore(draft.attachments)
    clearDraft()
    box.current?.focus()
    requestAnimationFrame(() => box.current?.setSelectionRange(text.length, text.length))
  }, [clearDraft, draft, form, restore, threadId, worker.name])

  return (
    // 8px under the box: from md up above the bottom edge, level with the music player and the aside's tab bar, and on a phone above its tab bar, which holds Menu now; dashboard-view's first-load frame counts this box's height and margin, so a change here changes its margins too.
    <FieldGroup className="mb-2">
      <form.Field name="text">
        {(field) => (
          <Field className="relative">
            {menuOpen ? (
              // shadcn's Command on the popover's surface, in the box as AI Elements' PromptInputCommand sits in it, over the / on a wide screen and above the box on a phone; it never takes focus, so typing goes on in the box
              <Command
                ref={menu}
                label="Skills"
                shouldFilter={false}
                value={selected}
                onValueChange={setActive}
                onMouseDown={(event) => event.preventDefault()}
                // its left is kept so it never runs past the box's right edge
                style={
                  {
                    "--menu-bottom": `${place.bottom}px`,
                    "--menu-left": `clamp(0px, ${place.left}px, 100% - ${menuWidth})`,
                    "--menu-width": menuWidth,
                  } as CSSProperties
                }
                className="ring-foreground/10 absolute z-50 h-auto font-mono text-sm shadow-md ring-1 max-sm:inset-x-0 max-sm:bottom-full max-sm:mb-2 sm:bottom-(--menu-bottom) sm:left-(--menu-left) sm:w-(--menu-width) sm:max-w-full"
              >
                {/* about six rows, scrolling inside itself */}
                <CommandList className="max-h-52">
                  <CommandGroup>
                    {matches.map((name) => (
                      <CommandItem key={name} value={name} onSelect={() => pick(name)}>
                        <span className="truncate">/{name}</span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </CommandList>
              </Command>
            ) : null}
            <FieldLabel htmlFor={id} className="sr-only">
              {boxName}
            </FieldLabel>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                void form.handleSubmit()
              }}
              {...(config.hosted ? {} : attachments.dropProps)}
              data-dragging={attachments.dragging || undefined}
              className="data-dragging:ring-ring/50 rounded-lg data-dragging:ring-2"
            >
              {/* at rest, the same border as the music player's card and the floating bars; a focused box still lights its border */}
              <InputGroup className="border-border">
                {attachments.chips.length || reply || loadLine ? (
                  <InputGroupAddon align="block-start" className="flex-col items-start gap-2">
                    {loadLine && (
                      <Badge
                        role="status"
                        variant={loadLine.failed ? "destructive" : "secondary"}
                        className="h-auto max-w-full text-left whitespace-normal"
                      >
                        {loadLine.text}
                      </Badge>
                    )}
                    {reply && (
                      <Badge variant="secondary" className="max-w-full">
                        <RiReplyLine aria-hidden />
                        <span className="truncate">
                          Replying to <span className="font-mono">{itemTag(reply)}</span> ·{" "}
                          {reply.title}
                        </span>
                      </Badge>
                    )}
                    {attachments.chips.length ? (
                      <AttachmentChips
                        className="w-full"
                        items={attachments.chips}
                        onRemove={attachments.remove}
                      />
                    ) : null}
                  </InputGroupAddon>
                ) : null}
                <InputGroupTextarea
                  ref={box}
                  id={id}
                  name={field.name}
                  value={field.state.value}
                  onBlur={() => {
                    field.handleBlur()
                    setClosed(menuKey)
                  }}
                  onChange={(event) => {
                    field.handleChange(event.target.value)
                    setCaret(event.target.selectionStart)
                  }}
                  onSelect={(event) => setCaret(event.currentTarget.selectionStart)}
                  onKeyDown={onKeyDown}
                  aria-autocomplete={skills.length ? "list" : undefined}
                  aria-controls={menuOpen ? menuIds.list : undefined}
                  aria-activedescendant={menuOpen ? menuIds.item : undefined}
                  onPaste={(event) => {
                    if (!config.hosted) attachments.onPaste(event)
                    const inserted = insertPaste(event)
                    if (inserted !== "left") markInserted(event.nativeEvent, inserted === "landed")
                  }}
                  aria-description={hint}
                  placeholder={
                    worker.usageLimit
                      ? `${label} is at its usage limit: a message now queues until it resets`
                      : onPicker
                        ? `${label} is on a prompt: a message now queues until it is answered`
                        : boxName
                  }
                  // one line to start, growing with the text, close over its buttons
                  rows={1}
                  className="field-sizing-content max-h-[40vh] min-h-0 overflow-y-auto px-3 pt-2 pb-1"
                />
                {/* 28px icon buttons (the mode menu keeps its own size) with 14px icons, 4px under the text and 8px over the edge, so the empty box stands as tall as the music player, 74px */}
                <InputGroupAddon
                  align="block-end"
                  className="px-2 pt-1 pb-2 [&_button[data-size=icon-sm]]:size-7 [&_svg]:size-3.5!"
                >
                  {/* an upload, a mode and a setting are writes the relay does not carry, so the hosted build's box sends words alone */}
                  {!config.hosted && (
                    <>
                      <input {...attachments.pickerProps} />
                      <Hint content="Attach images, PDFs or text files, or paste or drop them">
                        <InputGroupButton
                          aria-label="Attach files"
                          className="rounded-full"
                          onClick={attachments.pick}
                          size="icon-sm"
                          variant="outline"
                        >
                          <RiAddLine />
                        </InputGroupButton>
                      </Hint>
                      <ModePicker approvals={approvals} worker={worker} />
                    </>
                  )}
                  <div className="ml-auto flex items-center gap-2">
                    {/* New thread is off for now, so this row renders no toggle and a send starts no thread */}
                    {!config.hosted && <SettingPicker label={label} worker={worker} />}
                    {/* the box's own aria-description already speaks the key hint */}
                    <Hint content={hint} description={null}>
                      <InputGroupButton
                        aria-label={`Send to ${label}`}
                        className="rounded-full"
                        size="icon-sm"
                        type="submit"
                        variant="default"
                      >
                        <RiArrowUpLine />
                      </InputGroupButton>
                    </Hint>
                  </div>
                </InputGroupAddon>
              </InputGroup>
            </form>
          </Field>
        )}
      </form.Field>
    </FieldGroup>
  )
}

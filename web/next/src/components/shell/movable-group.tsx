"use client"

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { cn } from "cn"
import {
  createContext,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useContext,
  useRef,
} from "react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { SidebarGroupLabel } from "@/components/ui/sidebar"
import { MENU_HINT, openMenuByKey } from "@/lib/row-menu"

// A group's place in the order: its label's drag listeners, the click a drop raises swallowed, and its Move up and Move down, each null at its end.
type GroupMove = {
  down: (() => void) | null
  listeners: ReturnType<typeof useSortable>["listeners"]
  onClickCapture: (event: ReactMouseEvent) => void
  up: (() => void) | null
}

const GroupMoveContext = createContext<GroupMove | null>(null)

function SortableGroup({
  children,
  id,
  move,
}: {
  children: ReactNode
  id: string
  move: Omit<GroupMove, "listeners">
}) {
  const { isDragging, listeners, setNodeRef, transform, transition } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      className={cn(isDragging && "relative z-10")}
      style={{ transform: CSS.Translate.toString(transform), transition }}
    >
      <GroupMoveContext.Provider value={{ ...move, listeners }}>
        {children}
      </GroupMoveContext.Provider>
    </div>
  )
}

// The sidebar's groups in the order given, each one block dragged by its label: the pointer, or Space, the arrows and Space on the focused label, or Move up and Move down in the label's menu; each move calls onMove with the group's place among these and its new one.
export function MovableGroups<T extends string>({
  children,
  groups,
  onMove,
}: {
  children: (group: T) => ReactNode
  groups: T[]
  onMove: (from: number, to: number) => void
}) {
  // held from a drag's start until just after the click its drop raises: a pointer's at once, a key's on the Space key's release, which clicks the focused label
  const dragging = useRef(false)
  const byKey = useRef(false)
  const settle = () => {
    const release = () => {
      setTimeout(() => {
        dragging.current = false
      })
    }
    if (byKey.current) window.addEventListener("keyup", release, { capture: true, once: true })
    else release()
  }
  const onClickCapture = (event: ReactMouseEvent) => {
    if (!dragging.current) return
    event.preventDefault()
    event.stopPropagation()
  }
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Enter opens and closes the group, so Space alone starts and ends a keyboard move
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { cancel: ["Escape"], end: ["Space"], start: ["Space"] },
    }),
  )
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={({ activatorEvent }) => {
        dragging.current = true
        byKey.current = activatorEvent instanceof globalThis.KeyboardEvent
      }}
      onDragCancel={settle}
      onDragEnd={({ active, over }) => {
        settle()
        if (!over || active.id === over.id) return
        onMove(groups.indexOf(active.id as T), groups.indexOf(over.id as T))
      }}
    >
      <SortableContext items={groups} strategy={verticalListSortingStrategy}>
        {groups.map((group, at) => (
          <SortableGroup
            key={group}
            id={group}
            move={{
              down: at < groups.length - 1 ? () => onMove(at, at + 1) : null,
              onClickCapture,
              up: at > 0 ? () => onMove(at, at - 1) : null,
            }}
          >
            {children(group)}
          </SortableGroup>
        ))}
      </SortableContext>
    </DndContext>
  )
}

// A group's label, one button that opens and closes it; inside MovableGroups it also drags the group and opens a menu of Move up and Move down, with any items of the group's own (menu) after them.
export function MovableGroupLabel({
  children,
  menu,
  open,
  setOpen,
}: {
  children: ReactNode
  menu?: ReactNode
  open: boolean
  setOpen: (open: boolean) => void
}) {
  const move = useContext(GroupMoveContext)
  const toggle = <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} />
  if (!move && !menu)
    return (
      <SidebarGroupLabel className="w-full pl-2.5" render={toggle}>
        {children}
      </SidebarGroupLabel>
    )
  return (
    <ContextMenu>
      <ContextMenuTrigger
        render={
          <SidebarGroupLabel
            className="w-full pl-2.5"
            render={toggle}
            aria-description={MENU_HINT}
            {...move?.listeners}
            onClickCapture={move?.onClickCapture}
            onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
              openMenuByKey(event)
              if (!event.defaultPrevented) move?.listeners?.onKeyDown?.(event)
            }}
          />
        }
      >
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          {move && (
            <>
              <ContextMenuItem className="text-xs" disabled={!move.up} onClick={() => move.up?.()}>
                Move up
              </ContextMenuItem>
              <ContextMenuItem
                className="text-xs"
                disabled={!move.down}
                onClick={() => move.down?.()}
              >
                Move down
              </ContextMenuItem>
            </>
          )}
          {menu}
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  )
}

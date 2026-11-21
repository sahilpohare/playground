"use client"

import { RiArrowRightSLine, RiHashtag, RiUserLine } from "@remixicon/react"
import { cn } from "cn"
import Link from "next/link"
import { usePathname } from "next/navigation"

import { GroupCount } from "@/components/shell/group-count"
import { MovableGroupLabel } from "@/components/shell/movable-group"
import { ROW_BOX } from "@/components/shell/row-box"
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { useGroupOpen } from "@/lib/sidebar-groups"
import { isPlainClick } from "@/lib/threads"
import {
  channelHref,
  channelTitle,
  type YardChannel,
  type YardShell,
  yardBadge,
  yardGroups,
} from "@/lib/yard"
import { useYardChannels } from "@/lib/yard-api"

// The Channels and Direct messages groups, read from the API's Yard router; each is absent while it has no rows, and both while the stack has no Yard.
export function YardGroups({ shell }: { shell: YardShell }) {
  return (
    <>
      <YardGroup group="Channels" shell={shell} />
      <YardGroup group="Direct messages" shell={shell} />
    </>
  )
}

// One of Yard's two groups, absent while it has no rows. It collapses as every sidebar group does, its label the toggle, open to start and kept as you left it across reloads, and counts its rows; in the dashboard's sidebar its label also moves it (MovableGroupLabel).
export function YardGroup({
  group,
  shell,
}: {
  group: "Channels" | "Direct messages"
  shell: YardShell
}) {
  const { data } = useYardChannels()
  const [open, setOpen] = useGroupOpen(group, true)
  if (!data) return null
  const { channels, dms } = yardGroups(data)
  const rows = group === "Channels" ? channels : dms
  if (rows.length === 0) return null
  const tail = (
    <>
      <RiArrowRightSLine className={cn("transition-transform", open && "rotate-90")} />
      <GroupCount count={rows.length} />
    </>
  )
  return (
    <SidebarGroup>
      {/* each label written out, so the dashboard map reads its words */}
      {group === "Channels" ? (
        <MovableGroupLabel open={open} setOpen={setOpen}>
          Channels
          {tail}
        </MovableGroupLabel>
      ) : (
        <MovableGroupLabel open={open} setOpen={setOpen}>
          Direct messages
          {tail}
        </MovableGroupLabel>
      )}
      {open && <YardRows rows={rows} shell={shell} />}
    </SidebarGroup>
  )
}

// A group's rows, each a Threads row's shape: the stock 32px row, its icon, then a channel's bare name (the # icon is its one hash) or the other member's login, cut at its end, its unread count as the badge.
export function YardRows({ rows, shell }: { rows: YardChannel[]; shell: YardShell }) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  return (
    <SidebarMenu className="space-y-0.5">
      {rows.map((row) => {
        const title = channelTitle(row)
        const href = channelHref(row, shell)
        const badge = yardBadge(row)
        // the tooltip says a mention in words, so the badge's colour is never its only mark
        const tip = badge
          ? `${title} · ${badge.label} unread${badge.mention ? ", mentions you" : ""}`
          : title
        return (
          <SidebarMenuItem key={row.id}>
            <SidebarMenuButton
              render={
                <Link
                  href={href}
                  onClick={(event) => {
                    if (isPlainClick(event) && isMobile) setOpenMobile(false)
                  }}
                />
              }
              isActive={pathname === href}
              tooltip={{ children: tip, hidden: false }}
              aria-description={tip}
              className={ROW_BOX}
            >
              {row.kind === "dm" ? <RiUserLine /> : <RiHashtag />}
              <span className="truncate text-xs">{row.kind === "dm" ? title : row.name}</span>
            </SidebarMenuButton>
            {badge && (
              <SidebarMenuBadge
                data-mention={badge.mention || undefined}
                className="data-mention:bg-destructive right-1.5 rounded-full data-mention:text-white"
              >
                {badge.label}
              </SidebarMenuBadge>
            )}
          </SidebarMenuItem>
        )
      })}
    </SidebarMenu>
  )
}

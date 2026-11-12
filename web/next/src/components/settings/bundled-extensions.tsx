"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"

import { WhatsappNumbers } from "@/components/settings/whatsapp-numbers"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { apiClient, unwrap } from "@/lib/api/client"
import { answer, BUNDLED_QUERY_KEY, BUNDLED_WORDS, type BundledRow } from "@/lib/extensions"

type Bundled = { bundled: BundledRow[] | null }

const readBundled = async (): Promise<Bundled> =>
  answer(unwrap(apiClient.v1.extensions.bundled.$get()))

// Settings > Extensions' bundled group: each extension Playground ships under extensions/, off until its switch turns it on, read after your own extensions and before core; WhatsApp's card also holds its two numbers. Nothing shows before ext init names a login, since the switch is a setting at the login's scope.
export function BundledExtensions() {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryFn: readBundled, queryKey: BUNDLED_QUERY_KEY })
  const toggle = useMutation({
    mutationFn: ({ name, on }: { name: string; on: boolean }) =>
      answer(
        unwrap(apiClient.v1.extensions.bundled[":name"].$put({ json: { on }, param: { name } })),
      ),
    onError: (error) => toast.add({ title: error.message, type: "error" }),
    onSuccess: (written, { name, on }) => {
      queryClient.setQueryData(BUNDLED_QUERY_KEY, written)
      toast.add({
        title: `${BUNDLED_WORDS[name]?.title ?? name} turned ${on ? "on" : "off"}`,
        type: "success",
      })
    },
  })
  if (!data?.bundled) return null
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium">Bundled with Playground</h3>
      <p className="text-muted-foreground text-xs">
        Off until you turn one on. Its skills load in sessions started after that, read after your
        extensions and before core.
      </p>
      <ItemGroup className="gap-2">
        {data.bundled.map((row) => {
          const words = BUNDLED_WORDS[row.name]
          return (
            <Item
              key={row.name}
              role="listitem"
              size="sm"
              variant="outline"
              className="items-start"
            >
              <ItemContent className="min-w-0 gap-1.5 py-1 text-xs">
                <ItemTitle>{words?.title ?? row.name}</ItemTitle>
                {words && (
                  <ItemDescription className="text-xs">{words.description}</ItemDescription>
                )}
                {row.name === "whatsapp" && <WhatsappNumbers />}
              </ItemContent>
              <ItemActions>
                <Switch
                  aria-label={`${words?.title ?? row.name} on`}
                  checked={row.on}
                  disabled={toggle.isPending}
                  onCheckedChange={(on) => toggle.mutate({ name: row.name, on })}
                  size="sm"
                />
              </ItemActions>
            </Item>
          )
        })}
      </ItemGroup>
    </div>
  )
}

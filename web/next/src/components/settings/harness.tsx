"use client"

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useState } from "react"

import { ConfirmDialog } from "@/components/common/confirm-dialog"
import { useDashboard } from "@/components/dashboard/dashboard"
import { HarnessCards } from "@/components/first-run/harness-cards"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import {
  ALPHA_QUERY_KEY,
  canStart,
  HARNESSES_QUERY_KEY,
  type HarnessId,
  readAlpha,
  readHarnesses,
  readSwitch,
  startSwitch,
  switchMessage,
} from "@/lib/harness"

const POLL_MS = 2_000

// Settings > Harness: the same cards first run picks from, the radio on the harness Alpha runs on, and Switch Alpha once another card is picked and ready, behind a confirm, since it ends the running Alpha: Alpha is asked for its handoff through the outbox, as this click, and the new Alpha starts on the other harness from it. While it runs the step it is on shows, and a failure says why.
export function Harness() {
  const queryClient = useQueryClient()
  const { outbox } = useDashboard()
  const alpha = useQuery({ queryFn: readAlpha, queryKey: ALPHA_QUERY_KEY })
  const harnesses = useQuery({ queryFn: readHarnesses, queryKey: HARNESSES_QUERY_KEY })
  const [pick, setPick] = useState<HarnessId>()
  const [confirming, setConfirming] = useState(false)
  const status = useQuery({
    queryFn: readSwitch,
    queryKey: ["dispatcher", "switch"],
    refetchInterval: (query) => (query.state.data?.state === "running" ? POLL_MS : false),
  })
  const begin = useMutation({
    mutationFn: startSwitch,
    onSuccess: (read) => {
      setConfirming(false)
      const message = switchMessage(read)
      if (message) outbox.send(message.to, { attachments: [], text: message.text })
      queryClient.setQueryData(["dispatcher", "switch"], read)
      void queryClient.invalidateQueries({ queryKey: ALPHA_QUERY_KEY })
    },
  })
  const running = status.data?.state === "running"
  useEffect(() => {
    if (status.data?.state === "ok")
      void queryClient.invalidateQueries({ queryKey: ALPHA_QUERY_KEY })
  }, [queryClient, status.data?.state])

  const cards = harnesses.data
  const current = alpha.data
  if (!cards || !current) return null
  const picked = pick ?? current
  const label = cards.find((card) => card.id === picked)?.label ?? picked
  const failure =
    begin.error?.message ?? (status.data?.state === "failed" ? status.data.reason : null)
  return (
    <section aria-labelledby="settings-harness" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="settings-harness" className="text-muted-foreground text-sm font-medium">
          Harness
        </h2>
        <Button
          size="sm"
          disabled={picked === current || !canStart(cards, picked) || running}
          onClick={() => setConfirming(true)}
        >
          {running && <Spinner />}
          Switch Alpha
        </Button>
      </div>
      <HarnessCards
        cards={cards}
        onPick={setPick}
        onSettled={() => void harnesses.refetch()}
        pick={picked}
      />
      {running && status.data?.step && (
        <p className="text-muted-foreground text-xs">{status.data.step}</p>
      )}
      {failure && <p className="text-destructive text-xs">{failure}</p>}
      <ConfirmDialog
        action={`Switch to ${label}`}
        description={`Alpha writes its handoff and stops, then starts again on ${label} from it. Its chat pauses until it is back.`}
        onConfirm={() => begin.mutate(picked)}
        onOpenChange={setConfirming}
        open={confirming}
        pending={begin.isPending}
        title={`Switch Alpha to ${label}?`}
      />
    </section>
  )
}

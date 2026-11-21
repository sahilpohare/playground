"use client"

import type { Worker } from "@api/hono"
import { RiArrowDownSLine } from "@remixicon/react"
import { useMutation } from "@tanstack/react-query"
import { useState } from "react"

import { Hint } from "@/components/hint"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { InputGroupButton } from "@/components/ui/input-group"
import { toast } from "@/components/ui/toast"
import {
  changeSetting,
  choiceSetting,
  EFFORT_LABELS,
  effortFixed,
  heldPick,
  isEffort,
  localChoice,
  MODEL_LABELS,
  modelChoice,
  pickerWords,
  reportedSetting,
  shownValue,
  type Pending,
  type SessionEffort,
  type SessionSetting,
} from "@/lib/session-setting"

// The session's model and effort in the composer's toolbar, directly left of Send at the row's 28px, as /model and /effort set them in a terminal: one menu with a radio group for each, where a pick sets that value on the session as the owner's own act (typed into a dispatcher or the assistant, through the SDK on the hosted session). The hosted session's row may list local models too, in a group of their own under the cloud ones: picking one restarts it on that model's server, and the API's refusal (a turn running, the server down or serving another model) shows as its toast.
export function SettingPicker({ label, worker }: { label: string; worker: Worker }) {
  const reported = { ...reportedSetting(worker), model: modelChoice(worker) }
  const local = worker.localModels ?? []
  const [model, setModel] = useState<Pending<string> | null>(null)
  const [effort, setEffort] = useState<Pending<SessionEffort> | null>(null)
  const change = useMutation({
    mutationFn: async (setting: SessionSetting) => {
      const { error } = await changeSetting(worker.sessionId, setting)
      if (heldPick(error)) return { queued: true }
      if (error) throw new Error(error.message)
      return { queued: false }
    },
    onSuccess: ({ queued }) => {
      if (queued) toast.add({ title: `${label} takes it once free`, type: "info" })
    },
    onError: (error, setting) => {
      if ("effort" in setting) setEffort(null)
      else setModel(null)
      toast.add({ title: error.message, type: "error" })
    },
  })
  // a pick is forgotten once the row has moved off the value it was picked over, so a later change the session makes itself shows
  if (model && reported.model !== model.from) setModel(null)
  if (effort && reported.effort !== effort.from) setEffort(null)
  // while a pick loads its model the menu shows the model the chat still runs, and the composer's line says what loads
  const shownModel = worker.localLoad ? reported.model : shownValue(model, reported.model)
  const shownEffort = shownValue(effort, reported.effort)
  const pickModel = (next: string) => {
    const setting = choiceSetting(next)
    if (!setting || next === shownModel) return
    setModel({ from: reported.model, to: next })
    change.mutate(setting)
  }
  const words = pickerWords(worker, shownModel, shownEffort)
  const fixed = effortFixed(worker, shownModel)
  return (
    <DropdownMenu>
      <Hint content="Model and effort">
        <DropdownMenuTrigger
          render={
            <InputGroupButton
              size="sm"
              variant="outline"
              className="h-7 gap-1 px-2.5 text-xs"
              aria-label={`Model and effort: ${words}`}
              disabled={change.isPending}
            />
          }
        >
          {words}
          <RiArrowDownSLine />
        </DropdownMenuTrigger>
      </Hint>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Model</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={shownModel ?? ""} onValueChange={pickModel}>
            {Object.entries(MODEL_LABELS).map(([value, text]) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                {text}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        {local.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel>Local model</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={shownModel ?? ""} onValueChange={pickModel}>
                {local.map(({ id, label: words }) => (
                  <DropdownMenuRadioItem key={id} value={localChoice(id)} closeOnClick>
                    {words}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{fixed ? "Effort, set when it started" : "Effort"}</DropdownMenuLabel>
          {/* on the served local model the list still opens to browse, but takes no pick (effortFixed) */}
          <DropdownMenuRadioGroup
            disabled={fixed}
            value={shownEffort ?? ""}
            onValueChange={(next) => {
              if (!isEffort(next) || next === shownEffort) return
              setEffort({ from: reported.effort, to: next })
              change.mutate({ effort: next })
            }}
          >
            {Object.entries(EFFORT_LABELS).map(([value, text]) => (
              <DropdownMenuRadioItem key={value} value={value} closeOnClick>
                {text}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

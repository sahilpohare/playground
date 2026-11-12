"use client"

import { CheckRow } from "@/components/first-run/checks"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import type { HarnessCard, HarnessId } from "@/lib/harness"

// One card for each harness Alpha can start on, picked by its radio: its Installed, Signed in and Plan rows, each failed one with its fix's button (the first run's own CheckRow), and the refusal in plain words while its start would be refused. First run's step and Settings' Harness section both show it.
export function HarnessCards({
  cards,
  onPick,
  onSettled,
  pick,
}: {
  cards: HarnessCard[]
  onPick: (id: HarnessId) => void
  onSettled: () => void
  pick: HarnessId
}) {
  return (
    <RadioGroup
      aria-label="Alpha's harness"
      className="grid w-full gap-3"
      onValueChange={(value) => onPick(value as HarnessId)}
      value={pick}
    >
      {cards.map((card) => (
        <Card key={card.id} size="sm" className="text-left">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <RadioGroupItem id={`harness-${card.id}`} value={card.id} />
              <Label htmlFor={`harness-${card.id}`}>{card.label}</Label>
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <ul aria-label={`${card.label}'s checks`} className="grid gap-3">
              {card.checks.map((check) => (
                <CheckRow key={check.name} check={check} onSettled={onSettled} signedIn />
              ))}
            </ul>
            {card.refusal && <p className="text-muted-foreground text-xs">{card.refusal}</p>}
          </CardContent>
        </Card>
      ))}
    </RadioGroup>
  )
}

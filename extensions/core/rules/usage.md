A usage pause stops only the jobs that call a model; read this file in full before you forecast an account's week.
Forecast an account's week from its own readings alone: its pace from the first reading after the last move of sessions onto it, set against that account's own week reset.
A start before the move counts hours the account sat idle and reads slow, and another account's reset puts the deadline at the wrong time.
Every Claude account's week is used to about 100% by its reset: the account runs out early when the time its pace reaches 100% comes before that reset, and leaves points unused when it comes after.
Enough Claude work stays queued that no reset finds points unused, and spawn.sh's usage gate is the only usage stop on a Claude start.
That gate judges an `--account X` start at the same pace as a bare start, on X's own `usage-<local part>.json`, which ops-tick's `other-logins` beat writes every 30 minutes for each login but the stored one; it skips only while no such file is under 60 minutes old, and two failed reads of a login in a row tell ops.
A usage report lists every account the factory holds, the stored login included, and keeps an account with no fresh reading as stale with its age, so no account drops out of view.
While an account the split can pick would leave points unused by this forecast, its week projecting under 100% at its own reset, ops-sweep turns the week pace off an hour at a time; once none would, the pace comes back.
A forecast is labelled estimated and its readings measured (**verify**).
scripts/ops/README.md's Usage forecasts section holds where the readings live and how to print the table.
A card that offers a Claude start states its measured `--check` result; to-inbox's `SKILL.md` (`extensions/core/skills/to-inbox/SKILL.md`) holds it. Open the priority window, on the owner's or the dispatcher's word, before a `--check --priority`, or check without `--priority`.

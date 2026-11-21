# A peer runs its listed root steps with no password

A machine in org.ts's cluster has no desktop the owner uses, so no password window there can answer a root step, and a window here cannot answer for it.
The owner chose to do that machine's root setup from this one's Inbox, giving its admin password once, and to let its listed steps run after that with no password.

## Decision

- **One install through sudo, its password used once.** The owner enters the machine's admin password in a `secret` card, whose keychain sink is `playground-<machine>-sudo`. The install reads it there, sends it on stdin alone to `ssh <target> sudo -S`, and deletes the item on every path, so no argv, log, file or session holds it.
- **A polkit rule for the listed steps alone.** The install writes one polkit action per listed script, each pinned to its root-owned path, and one rule that answers yes to those actions alone, for the user whose sudo ran the install.
- **Each later step is one Approve.** It runs `pkexec` over `ssh -o BatchMode=yes` with no password, after reading that the installed script is root's own and holds this checkout's bytes.

## Consequences

- While the rule stands, any process running as that user on that machine can run each listed script as root with no password. The scripts are fixed and take no argument, so nothing else gains root.
- Removing `/etc/polkit-1/rules.d/49-playground-root.rules` and `/usr/share/polkit-1/actions/org.playground.root.policy` there undoes it, and the peer install card says so.
- A new listed step needs a new install card there, since its action and the rule name each step by name.
- `tests/api/hono/src/lib/dashboard/inbox.test.ts` holds that the password reaches no argv, line or log and is deleted once, on success, a failure, a timeout and a throw, and at the next start after a restart cut the install off. `tests/api/hono/src/lib/system/peer-root.test.ts` holds that the install text reads no stdin and writes the rule for that user alone.

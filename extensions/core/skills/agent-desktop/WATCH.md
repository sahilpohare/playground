# Watching the owner's desktop on Linux

A watch reads what the owner's desktop already records and takes no input, window or focus, so the owner's pointer, keys and apps stay the owner's own.
Section 5's privacy rule holds for everything a watch logs.

- **Tab switches:** Helium's session files, `~/.config/net.imput.helium/Default/Sessions/Session_*` (SNSS), record each tab activation as command 21 with its last active time: a millisecond timeline of tab switches, read with no process attached to the browser.
  Copy the newest file before Helium rotates it (every few minutes), and parse the copy.
- **Clicks and wheel steps:** a passive XI2 raw-event listener through `bun:ffi` logs them as they happen, since every listening client gets a raw event and the listener takes none of the owner's input.
- **The listener's form:** use that listener alone, since `xinput test-xi2 --root` takes the root window's click selection while it runs, and that selection is the owner's.

Done when the watch's log came from those reads alone, and the owner's pointer, focus and apps stayed as the owner left them.

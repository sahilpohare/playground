---
name: slack
description: "Slack mode: answer the owner's Slack DM with `playground dm send` while the owner is away. Use when the DM watch hands you an owner message, or at its 15-minute line asking for an update."
license: Complete terms in the repository's NOTICE
---

# Slack mode

While the `slack.mode` setting is on, the owner is away and reads only the owner's own Slack DM, so the DM is the owner's chat with the factory.
ops-dm-watch reads the DM each minute and sends each new owner message to the dispatcher in full.
A message with no reply in 3 minutes, or any message while the dispatcher has read stuck or failed for 3 minutes, also goes to the session in the assistant seat (`roster.ts who assistant`).
With no session there, it stays with the dispatcher alone and the job's log says so, and Ops hears of the stuck dispatcher.
A dispatcher mid-turn, its session state `working` and written in the last 3 minutes, holds the no-reply hand-on until it stops, since its reply waits behind that turn.

1. Answer every owner message the job hands you, even a one-word one: write the reply to a file and run `playground dm send <absolute path>`.
   The Assistant answers only what the job hands it, the same way, and routes nothing.
   When it prints anything but `dm send: posted`, such as `Slack is not set up here`, it has posted nothing: post the reply to the Inbox with `playground ask new`, as an update.
   When that line is `the Slack token is not in the Keychain`, the update also says the owner saves the token through the Inbox's secret ask for `slack`.
   Done when the command prints `dm send: posted`, or the Inbox update's id.
2. At each 15-minute line from the job, post the owner an update on the factory's work the same way.
   Done when the update is posted, or nothing has changed since the last one and the reply says so.

`dm send` runs this skill's `scripts/send.ts`, which reads the owner's token from the Keychain's `slack` item in its own process, so no session, env var or argv holds it.
It posts the frame (the PLAYGROUND line, the body, the USER line), one post at a time and one send at a time, under a lock in the data folder.
It turns our last USER line into this reply's PLAYGROUND line only while that line is the DM's latest message.
It repairs an owner message that landed mid-send, marks the DM unread from the message before its first post, and refuses a body no-playground-leak refuses.
Post to the DM through `dm send` alone: it records each post it makes, and the job tells our posts from the owner's by that record, so a post made any other way reads as the owner's.

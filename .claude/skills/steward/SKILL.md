---
name: steward
description: How Claude should follow pull requests in this repo after opening or being asked to watch them. Read before acting on PR events or scheduling PR check-ins.
---

# PR stewardship

## Rely on the subscription, not check-ins

When this session is subscribed to a PR's activity, do not schedule self check-ins (`send_later` or any other timer) to re-poll it. Comments, reviews, CI failures and merges arrive as events. Ending the turn is how to wait.

- A green, mergeable PR that is only waiting on the owner's go-ahead gets no check-ins at all. Say once that it is ready, then stop.
- One exception: if CI is red and you have pushed a fix, you may schedule a single check-in to confirm the new run. Subscriptions do not reliably report CI success. Do not re-arm it.
- Don't poll deploys after a merge either. Report what state the deploy was in when you looked, and check again only if asked.

This overrides the default guidance to keep an hourly check-in scheduled until a PR is merged or closed.

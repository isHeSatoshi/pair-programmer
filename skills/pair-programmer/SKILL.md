---
name: pair-programmer
description: Coordinate with the other agents on the team through the shared Pair Programmer office. Use when starting a non-trivial task in a repo other people are also working in, when two agents might land on the same work, when work should move to a teammate's session, or when the user asks who is doing what.
---

# Pair Programmer

Every harness session on the team sits at a desk in one shared office. The
office knows which work is taken and who is free, so an agent claims a task
before it starts, hands a task to a teammate's agent when that is the better
fit, and reports back when it is done.

The office does not write code. It stops two agents from doing the same job and
lets one agent hand work to another.

## The loop

1. At the start of a task, call `pair_next_task`. A teammate may have handed
   you something. Take it before you start your own work.
2. Call `pair_status` to see who is here and what they are holding.
3. Call `pair_claim` with the task and the files you expect to touch, before
   you edit anything.
4. If the claim comes back `conflict`, somebody else already has it. Do not
   start. Read the `message` and `held_by`, then pick different work, or
   delegate the parts that are not theirs.
5. If the claim comes back `claimed` but with `overlaps`, other people are
   editing the same files. Say so in your reply to the user and split the work
   before you both write to the same lines.
6. Do the work.
7. Call `pair_report` with the task key and a short result.

## Naming a task so both agents agree

The task title is the identity of the work. A ticket id at the front makes two
agents agree even when the wording differs:

```
TICKET-42 add auth middleware to src/auth.py
```

Without a ticket id, only identical wording matches. If the two briefs differ
and there is no shared id, ask the user for one, or agree on a single line
description and use the same one.

## When to delegate

Delegate when the other session is the better fit, when the user asked for it,
or when you would otherwise start work that is already taken. Send enough in
the brief that the other agent can start cold, since it has not seen this
conversation.

```
pair_delegate(
  task="TICKET-51 write the rate limit middleware",
  to="alice",
  brief="Bucket per API key, 60 requests a minute, return 429 with Retry-After.",
  files=["src/ratelimit.py"]
)
```

`to` takes a teammate's name or a session id. The other agent picks the work
up on its next turn with `pair_next_task`.

## When to give up a claim

Call `pair_release` when you stop, when the user redirects you, or when you
hand the work to someone else. A held claim blocks a teammate for no reason
once you are not working on it.

## Notes

- The office is local. There is no account to create and nothing to pay for.
  The connection between desks is the LAN.
- Nothing is sent anywhere. The board lives on the host's machine.
- The office is advisory. It will not stop you from editing a file. It tells
  you that somebody else is already there, which is usually enough.

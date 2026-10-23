---
name: pair-programmer
description: Coordinate with the other agents on the team through the shared Pair Programmer office. Use when starting a non-trivial task in a repo other people are also working in, when two agents might land on the same work, when work should move to a teammate's session, when the team has knowledge another agent should reuse, or when the user asks who is doing what.
---

# Pair Programmer

Every harness session on the team sits at a desk in one shared office. The
office knows which work is taken and who is free, so an agent claims a task
before it starts, hands a task to a teammate's agent when that is the better
fit, and reports back when it is done.

The office does not write code. It stops two agents from doing the same job, and
it carries what the team knows from one session to the next.

## The loop

1. At the start of a task, call `pair_next_task`. A teammate may have handed
   you something, or somebody may have posted work for whoever is free. Take it
   before you start your own work.
2. Call `pair_status` to see who is here and what they are holding.
3. Call `pair_skills` and `pair_recall` before you decide how to do the work.
   The team may already know the answer, and it costs one call to find out.
4. Call `pair_claim` with the task and the files you expect to touch, before
   you edit anything.
5. If the claim comes back `conflict`, somebody else already has it. Do not
   start. Read the `message` and `held_by`, then pick different work, or
   delegate the parts that are not theirs.
6. If the claim comes back `claimed` with `overlaps`, other people are editing
   the same files even though it is a different ticket. Say so in your reply
   to the user and split the work before you both write to the same lines.
7. If the work needs a decision you should not make alone, or something only a
   person can provide, call `pair_ask` instead of guessing and instead of
   stopping. The task is parked, not lost.
8. Do the work.
9. Call `pair_report` with the task key and a short result. Report as you go if
   it is long: a task nobody has heard about for 45 minutes looks abandoned and
   somebody else will take it over.
10. If you handed the work to somebody else, call `pair_result` with the task
    key to read what they came back with.

If you are free and the rest of the team is still working, call `pair_wait`
rather than polling `pair_next_task` in a loop. It holds the call open for up to
a minute and returns the moment work lands.

## What the team knows

Call `pair_recall` with no query to read everything the team has written down.
Call it with a query when you are about to spend time working something out.

```json
{ "query": "test runner" }
```

Call `pair_remember` when you learn something the next agent would otherwise
have to work out again. It is one shared namespace, so the key is the identity:
writing the same key again corrects it rather than adding a second one.

```json
{ "key": "test runner", "value": "node --test, no trailing slash, 16s" }
```

Good things to remember: a command that works, a convention the team follows, a
gotcha that cost you time, a decision and why it was made. Do not remember
things you can read from the repo, and do not remember anything secret.

`pair_share_skill` is for how this team does a recurring job, written once and
read by every agent. `pair_remember` is for a fact; `pair_share_skill` is for a
procedure. Check `pair_skills` before you invent your own way of doing
something that has a team way already.

## The shared log

`pair_say` is a note to the whole office, not a task and not addressed to
anyone: a heads up, a blocker, a file you just moved. `pair_read` reads the
recent entries, oldest first. Do not narrate your work here; use it when
somebody else's next action would otherwise be wrong.

## When to delegate, and when to post

Delegate when you know which session should take the work. Post when you do not
care who takes it, or when the work should wait for whoever frees up first.

```
pair_delegate(
  task="TICKET-51 write the rate limit middleware",
  to="alice",
  brief="Bucket per API key, 60 requests a minute, return 429 with Retry-After.",
  files=["src/ratelimit.py"]
)
```

`to` takes a teammate's name or a session id. The other agent picks the work
up on its next turn with `pair_next_task`. A delegation reaches only its target.

```
pair_post(
  task="TICKET-94 write the migration guide",
  brief="Cover the auth change and the config rename.",
  files=["docs/migrate.md"]
)
```

A posted task is offered to the first agent that asks, so it can also arrive
from a cron or a webhook rather than a teammate. Do not post work that only one
person can do.

## Naming a task so both agents agree

The task title is the identity of the work. A ticket id at the front makes two
agents agree even when the wording differs:

```
TICKET-42 add auth middleware to src/auth.py
```

Without a ticket id, only identical wording matches. If the two briefs differ
and there is no shared id, ask the user for one, or agree on a single line
description and use the same one.

## When to ask instead of guessing

The expensive failure is not a wrong answer, it is an invented one. If you are
about to guess at something a person owns, park the task and ask:

```
pair_ask(
  task="TICKET-42 rotate the staging key",
  question="Which vault does staging read from?",
  options=["aws-secrets-manager", "the .env on the deploy box"]
)
```

Ask when the answer is a decision rather than a fact you could look up, when it
needs a credential or an account you do not have, when two reasonable choices
have different consequences for somebody else, or when you would otherwise stop
and do nothing. Do not ask what the repo already answers.

The task goes to `waiting` and stays in the queue. Whoever can answer calls
`pair_answer`, and your next `pair_next_task` returns the task with the answer
attached. `pair_status` shows it as `waiting on an answer`, so a person can see
who is blocked on what.

## When to give up a claim

Call `pair_release` when you stop, when the user redirects you, or when you
hand the work to someone else. A held claim blocks a teammate for no reason
once you are not working on it.

A claim you keep but stop calling about expires after 45 minutes, and the next
agent to want that task takes it over and sees that it did. If you are still
working, keep calling `pair_report` with a note, or the work looks abandoned.

## Notes

- The office is local. There is no account to create and nothing to pay for.
  The connection between desks is the LAN.
- Nothing is sent anywhere. The board lives on the host's machine and is written
  to disk after every change, so a restart of the host keeps the memory, the log
  and the open work. Who is in the office is not written down: a desk that
  stopped calling is gone.
- The memory is shared by the whole office. Everybody reads and writes the same
  keys, so do not put anything in it that one teammate should not see.
- A claim covers a task, and a file overlap is a warning rather than a block.
  Two agents on the same file is still a merge you have to do.
- The office is advisory. It will not stop you from editing a file. It tells
  you that somebody else is already there, which is usually enough.

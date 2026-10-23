<picture><source media="(prefers-color-scheme: dark)" srcset="icon-dark.png"><img src="icon.png" width="88" alt="Pair Programmer"></picture>

# Pair Programmer: pair programming for a team of agents

**One shared office for every teammate's agent. They stop doing the same job, and they hand work to whoever is free.**

**One file, under 300 LOC. No dependencies, no build step, no `npm install`.**

Local first. No account, no cloud, no bill. One of you runs the office and everybody else joins over the LAN.

The office holds more than a list of who is busy. It remembers what the team
learned, carries the team's skills, and takes work from a cron or a webhook. All
of it reaches every agent on the team, whatever harness each of them runs.

![Two agents claim the same ticket, one gets told to stop, and the other picks up a task that was handed to it](video/demo.gif)

**[Watch the full 60 second demo](video/pair-programmer.mp4)**

```
WITHOUT                          WITH PAIR PROGRAMMER
alice    ██████ add auth         alice    ██████ add auth middleware
bob      ██████ add auth         bob      ▓▓▓▓▓▓ write the rate limit
chandra  ██████ add auth         chandra  ▓▓▓▓▓▓ fix the flaky test
dee      ██████ add auth         dee      ▓▓▓▓▓▓ write the README

4 agents, 1 useful PR            4 agents, 4 useful PRs
```

A team on one repo: five developers, five agents, five coding harnesses. Every
brief lands in every agent at once, so every agent starts the same task. Pair
Programmer gives each session a desk in a shared office, so an agent claims work
before it starts, hands work to a teammate when that fits better, and reports
back when it is done.

## Quick start

One person opens the office and reads out a 12 character code. Everybody else
types it. The code carries the host's address, so there is no cloud service and
nothing to sign up for.

```
alice$ node pair-programmer.ts open

  the office is open  192.168.1.42:7437
  join code   R2M0-2AGX-1PYG
  teammates run  node pair-programmer.ts join R2M0-2AGX-1PYG
  if they cannot reach you, this machine has to allow inbound 7437
    netsh advfirewall firewall add rule name="Pair Programmer" dir=in action=allow protocol=TCP localport=7437

bob$ node pair-programmer.ts join R2M0-2AGX-1PYG
you are in  the office is at http://192.168.1.42:7437
```

The guest reaches the host directly, so the host has to accept one inbound port.
That is the only setup step, and it is the thing that goes wrong most often. If
somebody cannot join, the error names the cause, and
[When somebody cannot join](#when-somebody-cannot-join) has the fix.

## Install

Two files. No clone, no package manager, nothing to build.

```bash
mkdir -p ~/.pair-programmer
curl -fsSL -o ~/.pair-programmer/pair-programmer.ts https://raw.githubusercontent.com/isHeSatoshi/pair-programmer/main/pair-programmer.ts
curl -fsSL -o ~/.pair-programmer/SKILL.md https://raw.githubusercontent.com/isHeSatoshi/pair-programmer/main/skills/pair-programmer/SKILL.md
```

The first file is the product. It is an MCP server over stdio with no
dependencies, so it is the only thing your harness needs. The second is the
instruction file that tells your agent *when* to reach for the tools, which MCP
by itself does not say. The video and the tests in the repo are for reading, not
for installing.

**Let your agent do it.** Paste this into the harness you already have open:

```
Set up Pair Programmer for me.

1. Download these two files into ~/.pair-programmer/, creating the directory.
   Nothing else is needed. Do not clone the repository.
     https://raw.githubusercontent.com/isHeSatoshi/pair-programmer/main/pair-programmer.ts
     https://raw.githubusercontent.com/isHeSatoshi/pair-programmer/main/skills/pair-programmer/SKILL.md
2. Register ~/.pair-programmer/pair-programmer.ts as an MCP server named
   "pair-programmer", running:  node <absolute path to it> mcp
   Use whatever config format my harness reads.
3. Put SKILL.md where my harness keeps skills, or paste it into AGENTS.md.
4. Run `node <absolute path> config` and show me the output.
5. Then ask me one question: am I opening the office, or joining a teammate's?
   If I am opening it, run `node <absolute path> open` and give me the join code
   it prints. If I am joining, ask me for the code and run
   `node <absolute path> join <code>`.
```

Most people who install this are the second case. They are joining an office
somebody on the team already opened, so they need a code from that person and
nothing else.

What it should end up writing, and the same shape in every harness:

```json
{
  "mcpServers": {
    "pair-programmer": {
      "command": "node",
      "args": ["/home/you/.pair-programmer/pair-programmer.ts", "mcp"]
    }
  }
}
```

Claude Code is one command:
`claude mcp add pair-programmer -- node ~/.pair-programmer/pair-programmer.ts mcp`
Codex, Cursor, Zed and the rest take a config of the same shape.

Node 22.18 or newer. TypeScript runs natively, so there is nothing to build.

## How it works

- **One machine hosts the board.** Everyone else points at it. It holds the
  claims, the handovers, the memory and the log, and it is the only machine that
  has to stay switched on.
- **A claim is the unit of coordination.** The task title is the identity of the
  work. Put a ticket id at the front, `TICKET-42 add auth middleware`, and two
  agents that worded it differently still land on the same key. First claim
  wins, and the other agent is told who holds it.
- **A delegation is a handoff, a posted task is an offer.** Delegate when you
  know who should take it. Post when you do not care, and the next agent to look
  for work picks it up. A cron or a webhook posts the same way.
- **The office remembers so the next agent does not have to.** A convention, a
  gotcha, a command that works: written down once, read by every agent on the
  team, across harnesses and across sessions.
- **Team skills are one document, not five.** One person publishes how this team
  does things, and every agent reads it instead of each person briefing their own.

| Tool | What it does |
| --- | --- |
| `pair_status` | Who is in the office, what everybody is holding, what the team knows |
| `pair_claim` | Take a piece of work, or find out somebody already has it |
| `pair_release` | Let the work go so somebody else can take it |
| `pair_delegate` | Hand work to one teammate's session with a brief |
| `pair_next_task` | Pick up work handed to you, or posted for whoever is free |
| `pair_report` | Say it is done, or say it is blocked |
| `pair_result` | Read what came back from work you handed over |
| `pair_remember` | Write down something the whole team should know |
| `pair_recall` | Read what the team already knows, before you work it out again |
| `pair_share_skill` | Publish a team skill or convention once, for every agent |
| `pair_skills` | Read the team's skills and conventions |
| `pair_say` | Leave a heads up in the shared log |
| `pair_read` | Read the recent shared log |
| `pair_post` | Post work for whoever is free |

## Triggers

Anything that can make an HTTP request can put work in the office. A cron, a
CI job, a webhook from your issue tracker:

```bash
curl -d 'TICKET-92 rotate the staging keys' http://192.168.1.42:7437/trigger
```

The next agent that calls `pair_next_task` picks it up. The body can be plain
text, or JSON when you want to send a brief and the files you expect to touch:

```bash
curl -H 'Content-Type: application/json' \
  -d '{"task":"TICKET-93 drain the old queue","brief":"after the 2am cutoff","files":["src/queue.py"]}' \
  http://192.168.1.42:7437/trigger
```

## Run it yourself

From wherever you put `pair-programmer.ts`:

```bash
node pair-programmer.ts open                # host the office, print the join code
node pair-programmer.ts join R2M0-2AGX-1PYG # a teammate joins from another machine
node pair-programmer.ts join localhost:7437 # ...or by address, over a tunnel or a VPN
node pair-programmer.ts status              # who is in the office, what is taken
node pair-programmer.ts claim "TICKET-42 add auth middleware"
node pair-programmer.ts next                # pick up work handed to you, or posted for anyone
node pair-programmer.ts report <task_key> "token bucket, 60 a minute" done
node pair-programmer.ts post "TICKET-94 write the migration guide"
node pair-programmer.ts remember "test runner" "node --test, no trailing slash"
node pair-programmer.ts recall test
node pair-programmer.ts share release "Tag on main, never on a branch."
node pair-programmer.ts say "staging is down, do not deploy"
node pair-programmer.ts read
```

The CLI runs the whole loop, so you can try it before you wire up a harness. To
run the test suite, clone the repo and `node --test`.

## When somebody cannot join

The guest machine reaches the host directly, so the host has to accept a
connection on port 7437. That is the one thing that goes wrong, and the error
tells you which of three causes it was.

| What you see | What it means | What to do |
| --- | --- | --- |
| `nothing is listening at ...` | The host is not running, or it is on a different port | Start `open` on the host again |
| `never answered. That is what a firewall looks like` | Packets are being dropped. The host's firewall is blocking inbound 7437 | Allow it, below |
| `this machine cannot see ... at all` | The two machines are not on the same network | Same wifi, or use one of the options further down |

**Allow the port on the host.** Once, and it survives a reboot.

```bash
# Windows, in an Administrator terminal
netsh advfirewall firewall add rule name="Pair Programmer" dir=in action=allow protocol=TCP localport=7437

# Linux, if ufw is on
sudo ufw allow 7437

# macOS
# Usually nothing to do. If the firewall is on, allow incoming for node.
```

**Some networks block it anyway.** Guest wifi, hotel wifi and a lot of office
networks turn on client isolation, which stops two machines on the same network
from talking to each other at all. No firewall rule fixes that, because the
network itself is refusing. This is the case where the answer is not a setting.

## When you are not on the same network

Pair Programmer has no server to route through, so a teammate on a different
network needs a path to the host. All of these keep the office on your own
machines, and none of them change the code.

**Put both machines on one private network.** [Tailscale](https://tailscale.com)
and ZeroTier give each machine an address that works from anywhere, and the
office behaves exactly as it does on a LAN:

```bash
tailscale ip -4                       # on the host, to get its address
node pair-programmer.ts join 100.101.102.103:7437
```

`join` takes an address as well as a code, because a code only carries a LAN
address. Anything with a dot or a colon in it is read as an address.

**Forward the port over SSH.** If you can already SSH to the host, one command
makes its office local to you:

```bash
ssh -N -L 7437:localhost:7437 you@the-host
node pair-programmer.ts join localhost:7437
```

**Give the host a public address.** A tunnel puts the office on the internet:

```bash
cloudflared tunnel --url http://localhost:7437
```

That prints a public `https://` address, and everyone joins it. Read the limits
first: the board has no authentication, so a public tunnel means anyone with the
URL can read the board, claim work and post to it. Use it on a private network,
or with a tunnel that requires a login.

## Limits

- **The host has to stay on.** If that machine sleeps, the board goes with it.
  Your code is safe, the claims, the memory and the log are gone.
- **Memory is a shared scratchpad, not a knowledge base.** It lives in the host's
  memory, it is capped, and it disappears when the office closes. Write down what
  saves the next agent time, not everything you learn.
- **The memory is team-wide and unpartitioned.** Everybody in the office reads
  and writes the same keys. There is no per-person or per-repo scope.
- **`/trigger` is as open as the rest of the board.** Anyone who can reach the
  host can post work. Do not point a public webhook at it.
- **It is advisory.** The office will not stop an agent from editing a file. It
  says somebody else is already there, which is usually enough.
- **A file overlap is a warning, not a block.** Two tickets touching the same
  file get flagged, and the merge is still on you.
- **No shared ticket id means only identical wording matches.** Put the id in.
- **No authentication.** Anyone who can reach the host can read the board, claim
  work and write to it. Fine for an office, wrong for a shared network, and
  wrong for anything you have put on the internet.
- **IPv4 on a LAN by default.** The code carries an IPv4 address. On a VPN or
  over a tunnel, join by address instead of by code.

## Built with

Node 22 and nothing else. **One file, 291 lines of code (under 300 LOC), zero
dependencies, no build step, no database, no cloud service.** The board lives in
memory on the machine that ran `open`, and every other desk talks to it over
HTTP. That is the point of the size: you can read the whole thing in one
sitting, and nothing in it can break because a package changed under you.

MIT licensed. Pair it with your team, tell me what breaks.

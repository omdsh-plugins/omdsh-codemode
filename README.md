# omdsh-codemode

English | [中文](README.zh.md)

Code mode for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) web GUI: a third segment beside **Chat** and **Work** whose column is the harness's own terminal, running in the conversation's workspace.

The web GUI and the terminal are two front doors onto the same harness. This plugin is the seam that lets one be shown inside the other — pressing **Code** replaces the conversation column with a real `dsh --profile omdsh-tui`, banner and all, in the directory the conversation is already accounted under.

## What it adds

| Surface | Where it comes from |
|---|---|
| The **Code** segment in the mode switch | A registration in `sessionModes`, the segment registry [omdsh-base](https://github.com/omdsh-plugins/omdsh-base) publishes |
| The terminal column | An entry in `conversation`, ui-layout's single seat for the whole centre, registered at a lower priority than the shipped conversation and disposed when the mode is left |
| The socket behind it | `GET /omdsh-codemode/terminal` (WebSocket upgrade), fenced exactly like `/api` |
| Code conversations in the sidebar, under the workspace they ran in | `Workspace.attachSession` on the harness's own registry, once the terminal has written something |
| **New Session** starting another terminal instead of leaving the mode | The `newSession` answer this plugin's segment registers, which the switch offers to whoever holds the column |
| Sidebar rows following a `/rename` made inside the terminal | The window title the terminal announces, read off the bytes this plugin already relays |
| The red dot on those rows | The `tone` and the `owns` classifier this plugin's segment carries; the sidebar's dots are painted by [omdsh-base](https://github.com/omdsh-plugins/omdsh-base) for whatever modes are registered |

**Nothing in the harness is modified, and nothing of the terminal is reimplemented.** What is on screen is `@omdsh-plugins/omdsh-tui`'s own front door — its transcript, tool cards, `/resume`, every key it binds — because this plugin starts that program and relays bytes.

## The column is taken, not owned

`conversation` is a **single-occupancy** slot: entries are priority-sorted and the lowest renders, so registering below the shipped conversation shadows it outright. That is the whole implementation of "the main view shows only the terminal" — and it is also why the registration is added when the segment is pressed and disposed when the segment loses the column, rather than held from mount. A plugin that registered there permanently would not be a mode; it would be a replacement.

Taking the seat means wearing what the seat publishes. The mode switch rides `shell.overlay` — a layer spanning the sidebar and the details panel too — and centres itself on the box carrying `data-conversation-scroll`, the attribute the conversation skeleton puts on its scrollport. This column carries it as well, because without it the switch loses its anchor the instant Code mode takes the column and snaps to the centre of the whole frame, which reads as the control jumping sideways on every mode change.

Which segment is on is the switch's business, not this plugin's. The registry allows exactly one active segment, so pressing **Chat** or **Work** clears this one, and the column follows that flag down. There is no second source of truth to disagree with the pressed state.

## A Code conversation is a conversation

Code mode **names** the session its terminal drives (`code-session-<uuid>`, handed to the terminal as `--session-id`) instead of letting the process mint one for itself. Everything else here follows from that one decision:

- **The row in the sidebar.** A terminal conversation reaches the sidebar on its own — the web GUI lists every persisted session — but as a stray under **Ungrouped**, because only the process that created a session ever accounts for it and that process is not this host. Knowing the id up front lets the host attach it to the workspace it ran in, so it lands in the group where the user started it.
- **Coming back to it.** Clicking that row opens the conversation, this plugin sees a session it started, and the column follows: the terminal boots on the same id, which the terminal app treats as create-or-continue. Same conversation, same agent memory, further turns appended to the same log and the same row.
- **The red dot.** "Did Code mode start this?" is a question about the id, so it needs no bookkeeping, survives a restart, and answers the same in every tab.

The id is the whole record — there is no table beside the session store to disagree with it.

**Accounted once it has begun, and not before.** The terminal app writes a session header the moment it starts, so a terminal opened and never typed into leaves a real, if tiny, log behind. The host reads such a conversation as `blank` — and `blank` is not merely "hidden from the sidebar". It is the frame's word for *a conversation New Session may reuse*: `workspaces.connectWorkspace` scans the workspace's account for one and opens it. A turn-less Code conversation left in that account is therefore handed straight back the next time the user presses New Session in Chat or Work — the column turns into a terminal and the mode changes under them — and the same reuse drives the frame's initial workspace selection, so a page can open into a terminal nobody asked for. There is nothing to weigh against that, because the sidebar draws no blank rows in the first place. So the account follows the conversation in both directions: attached once a turn has run in it, taken back out while none has.

**Terminals are keyed by that session**, not by the directory. A directory key made "one agent per tree" structural but left a Code conversation unaddressable: a workspace could only ever have its most recent terminal, and one the user left could never be reopened. Two terminals in one tree are now possible, and are the user's own explicit act — the same thing two `dsh` windows in one directory have always been.

A terminal outlives its socket. Leaving Code mode, switching conversations, and reloading the page all drop the socket, and none of them mean "kill my agent mid-turn" — so the process stays for a grace period, its output accumulates into a bounded transcript, and the next connection replays that transcript before going live. What ends one is the user exiting it, the grace expiring, this plugin unloading, or the host process going away — a terminal belongs to the host that started it, and an abandoned one would go on holding its conversation against whoever opens it next.

## A conversation renamed in the terminal is renamed in the sidebar

`/rename` in a Code terminal — and the name the agent generates after the first turn — is a durable change made by **another process**. The web host holds no agent for that conversation, so nothing pushes the new name to the page; worse, the host reads the projection table (where cold conversations' names live) once, when it starts, and serves every later listing from memory. Reloading the browser does not help: the staleness is behind the RPC, not in front of it.

The terminal announces the change itself, through the oldest channel there is — the window title (`OSC 0`), which every terminal program writes and every emulator parses. Both halves of this plugin read it off the same bytes they were already relaying:

- **The host** re-reads that one conversation from its log (the projection cache's own cold read, which stores what it folds), so the next listing is current. It repeats on a short widening schedule, because the terminal makes a rename durable on its own timing — a read fired the instant the title changes can rightly still see the old name.
- **The browser** re-pulls the session list a beat later, and stops as soon as the row moves.

The announcement is the trigger, never the answer: its text is the terminal's own label, and the session log stays the authority on what the conversation is called.

## Where the terminal runs

A terminal needs a **directory**, and a conversation is only one of the ways to name one. Three answers, in the order of how much the page already knows:

1. **The conversation on screen** — the project it is grouped under, falling back to its own recorded directory.
2. **The project the runtime itself would land in**, when nothing is open. `recentWorkspaceId` is the harness's own answer to "where were you", and the one it restores a conversation from; the top of the workspace list stands in when it names none.
3. **Wherever you say**, when no project is registered at all. Pressing **Code** on a fresh install opens the Host's directory picker, registers what you choose, and starts a terminal there — the same gesture the frame's own empty state offers under *Choose workspace*.

The second and third answers are why this segment is live on a page that has nothing open. It used to report the first one only, which meant it was permanently greyed out on a fresh install — a state invisible for as long as [omdsh-chatmode](https://github.com/omdsh-plugins/omdsh-chatmode) was composed beside it, because its managed Chat workspace means a conversation is always open. Both happen on the **press** and never while deriving, so a page nobody pressed Code on starts no terminal and mints no conversation.

The third answer needs the Host's *native* picker, which is what `dsh` mounts on macOS and Windows when it is serving the machine it runs on. A remote or headless Host drives an in-app directory browser instead — ui-workspace's own component, which a contributed mode has no way to open. There is no way to ask which is mounted, so the first press that finds out is what makes the segment stop offering the cold start and say what is missing instead; registering any project brings it straight back.

## What pressing Code shows you

Four answers, in the order of how much is actually known:

1. **The conversation the browser named** — the Code row that was clicked, or the terminal this page is already showing.
2. **This host's live terminal in that directory**, which is what makes a page reload land back on the same agent mid-turn: the socket drops, the process does not.
3. **The project's most recent Code conversation**, which is what pressing Code means on a host that has just started: come back to the work, not to an empty prompt. The most recent by the same clock the sidebar orders by, and never one nothing was said in — a terminal somebody opened and walked away from leaves one of those behind, and there is nothing in it to come back to.
4. **A new conversation**, when the project has none.

The order is the whole safety argument, and the third answer sits where it does deliberately. The browser can see the session list; it cannot see a running process. A conversation started a moment ago has nothing on disk to be "most recent", so a surface that outranked the live table would revive an older conversation over a running agent — and two live copies of one conversation interleave their sequence numbers until the log stops loading at all. So the browser **offers** (`resume=` on the socket) and the host decides, taking the offer only when it has nothing running in that directory. A log that some earlier accident already damaged that way is not beyond saving: `pnpm run repair:sessions` is the recovery tool for exactly that shape, and [Commands](#commands) says how to run it.

## New Session starts another terminal

Pressing **New Session** while Code mode holds the column means another Code conversation — in the project the button named, or the directory the terminal on screen is already in — not a web conversation and not a change of mode. The switch registry offers the request to whichever segment holds the column before the frame handles it, and this one answers.

The conversation is **named here rather than asked for**, and that is what makes the request idempotent: the socket reconnects, the column remounts, the window resizes, and every one of those asks for the same conversation instead of starting another terminal. The socket says `fresh`, which tells the host this id is newly minted rather than resumed — nobody can be holding it, so its terminal becomes this directory's terminal from the moment it starts.

Until its first turn is persisted the new conversation has no row, so the sidebar goes on showing the one you came from. The row appears on its own once that turn lands — and the selection does not move with it, because a Code conversation is **shown, never selected**: making one the runtime's current session is what makes this host resume it, on a log its terminal is still appending to. The cost is the sidebar highlight, which stays on the web conversation behind the terminal.

Two details are worth knowing before they surprise you:

- **A terminal nobody typed into leaves no row.** The harness persists a session lazily, on its first turn, so opening Code mode and walking away costs nothing and adds nothing. The row appears within seconds of the first turn (the host retries the attach on a short widening schedule) and never sooner. Until then it is a blank conversation and is treated as one: opening a blank Code conversation does not take the column, which is what stops the frame's own New Session — it reuses a workspace's blank conversation, whoever started it — from dropping a person into a terminal they did not ask for.
- **A restored terminal starts at the banner.** It is `dsh --resume`'s own behavior — the terminal app does not redraw a resumed transcript — so the conversation continues while the screen starts clean. Pressing **Work** on a Code conversation reads the same log in the web view, which is where its transcript is legible.

## What it runs

The launcher is **this runtime's own entry, re-executed**: the process serving the page is already a `dsh` launch, so its entry is the one launcher known to exist and known to be the same installation the user is talking to. No PATH lookup, no second install to keep in step.

```yaml
# The profile's own cordis.patch.yml, to change any of it:
- id: codemode
  config:
    profile: omdsh-tui       # the profile the column boots
    reconnectGraceMs: 300000  # how long a dropped terminal survives
```

A deployment whose runtime was **not** started by `dsh` — a packaged shell, a test — sets `command` (and `args`) instead; without either, the socket refuses with a message saying so rather than guessing at a binary.

Those four knobs — `profile`, `command`, `args`, `reconnectGraceMs` — are a plain TypeScript interface on the host half, not a [settings namespace](https://omdsh-plugins.github.io/conventions/?lang=en#rule-1). So they are edited where the sample above puts them, in the profile's own `cordis.patch.yml`, and this plugin's card in the plugin hub carries no form. They are composition facts rather than a person's preferences — which launcher a deployment re-executes is decided once, by whoever assembled the profile.

Whichever launcher is resolved, it is invoked with **`--session-id <id>`** appended, because Code mode names the conversation it starts. The profile it boots must understand that flag: [omdsh-tui](https://github.com/omdsh-plugins/omdsh-tui) takes it as create-or-continue for exactly that session, which is what makes a Code conversation something the sidebar can hold and a click can reopen.

## Security

The socket hands out a live agent process, so it is fenced exactly like `/api`: a `Host` header naming us (loopback, or an authority the deployment was told to serve) plus same-origin browser markers. This is a DNS-rebinding and cross-site defence, not authentication — a deployment that publishes `/api` to a network publishes this with it.

## Install

Requires a `dsh` on your PATH, and the web profile that carries the mode switch.

```sh
npx @omdsh-plugins/omdsh-plughub add omdsh-codemode
```

That is the [plugin hub](https://github.com/omdsh-plugins/omdsh-plughub)'s
installer with argv where the button was. It resolves this plugin from the
collection's [registry](https://github.com/omdsh-plugins/registry), installs it
from its GitHub repository, and writes the pnpm build-allowlist entry a bare
`dsh plugin add github:…` would leave to you — the entry carries the commit pnpm
resolved, so it can be copied out of a failure and never written down in
advance.

`dsh plugin --profile web add @omdsh-plugins/omdsh-codemode` is **not** that command yet:
this package is not on npm, and pnpm answers `ERR_PNPM_FETCH_404`. The same
install is also a button, on this plugin's card in **Settings → Plugins → Plugin
hub**, once the hub itself is in the profile.

[omdsh-base](https://github.com/omdsh-plugins/omdsh-base) — the switch it
registers into — is published, so that one installs by name:

```sh
dsh plugin --profile web add @omdsh-plugins/omdsh-base
```

Or from a checkout, which is what an unpublished build wants. `lib/` must exist before `dsh web` runs — the loader imports `lib/index.js` directly, and a path-installed package never has its `prepare` run, so nothing builds it for you:

```sh
pnpm install
pnpm run build

dsh plugin --profile web add "$PWD"           # this plugin
dsh plugin --profile web add ../omdsh-base    # the switch it registers into
```

The terminal it starts lives in **its own profile** (`omdsh-tui` by default), and that one is **checkout-only**: unlike every other companion named here it is not in the collection's registry, so there is no `@omdsh-plugins/omdsh-tui` to add. Install it the way [that repository](https://github.com/omdsh-plugins/omdsh-tui#install) describes, which is one script:

```sh
cd ../omdsh-tui && pnpm install && pnpm run install:profile
dsh --profile web
```

**Never add the terminal to the `web` profile.** `@omdsh-plugins/omdsh-tui-app` is a surface bundle, exactly as `@deepseek-ai/dsh-web-app` is, and a profile composes exactly one surface over `dsh-base`. Stacking them collides on seven loader ids — `code-runtime`, `storage`, `storage-json`, `storage-domain`, `session-projection-cache`, `session-stats`, `agent-presets` — and the whole page dies at mount on the first one:

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include
(cordis:include): duplicate loader entry id: code-runtime
```

Code mode **boots** that profile as a child process; it does not compose it. The two never share a layer stack.

Remove it the same way:

```sh
dsh plugin --profile web remove @omdsh-plugins/omdsh-codemode
```

Without [omdsh-base](https://github.com/omdsh-plugins/omdsh-base) the profile still composes and boots, and this plugin's browser half mounts and does nothing: `sessionModes` is resolved by service name, and every registration below it rides a restricted fiber that waits for it. That is the intended off state — there is no switch for a third segment to appear in, so Code mode leaves the page exactly as it found it.

What that off state must NOT be is a top-level `inject` on `sessionModes`. cordis waits for an injected service forever, and the web client sweeps every loader entry once the tree settles and fails the whole page for any left `pending` — so naming a contributed service there turns "Code mode is off" into `web boot: 1 entry did not activate`, a dead UI rather than a missing segment. The rule generalises to every service another plugin publishes, and is written down in [CONVENTIONS.md](https://omdsh-plugins.github.io/conventions/?lang=en#rule-9).

Two further companions are optional in the same way, reached the same way, and each has an off state that costs nothing:

- [omdsh-shortcuts](https://github.com/omdsh-plugins/omdsh-shortcuts) publishes `shortcut`. With it, the **Code** segment's tooltip names the chord that enters this mode and follows a rebinding with no reload. Without it the segment is unchanged and simply claims no key — this plugin binds none of its own, because entering a mode already has a published seam the keybinding layer calls.
- [omdsh-remdev](https://github.com/omdsh-plugins/omdsh-remdev) publishes `remdev`. With it, a workspace standing in for a directory on a server runs its terminal **there** — same conversation, same `--session-id`, a different machine — and the conversations it writes are pulled home as soon as the terminal's socket ends. Without it every directory is an ordinary local one and the terminal starts here, which is the mode this plugin shipped in.

## Commands

```sh
pnpm install
pnpm run build      # tsc emits lib/types, tsdown bundles the node and browser halves
pnpm run typecheck  # sources and tests
pnpm run test       # unit tests
```

`repair:sessions` is the recovery tool for the failure "What pressing Code shows you" describes — two live copies of one conversation interleaving their sequence numbers into one log. It reports by default and writes only when told to, because it edits conversations; every rewrite leaves the original beside it as `.bak`:

```sh
pnpm run repair:sessions                 # report on $DSH_HOME (or ~/.dsh)
pnpm run repair:sessions -- --write      # apply, keeping a .bak per log
pnpm run repair:sessions -- --home /path/to/dsh-home
```

Which harness this package compiles against is a switch:

```sh
pnpm run harness:npm                             # the committed state: the pinned release
pnpm run harness:local ../../deepseek-harness    # a sibling checkout, for development
pnpm run check:harness-pin                       # fails while any dependency is linked
```

**Only the registry state may be committed.** A `link:` specifier is resolved against the manifest that declares it, so a committed one bakes one machine's directory layout into the package — and pnpm does not fail loudly when it is wrong: it creates a dangling symlink, reports a successful install, and the build dies later with `TS2307` on every harness import. `check:harness-pin` exists to catch that before a commit.

## Where this came from

The pty registry, the socket bridge, and the browser-trust fence are adapted from [`omdsh-sidepanel`](https://github.com/omdsh-plugins/omdsh-sidepanel), which runs a shell in the same shape. What is new here is the launcher (a harness profile rather than `$SHELL`), the key (a directory rather than a conversation), and the seat (the whole column rather than a docked panel).

## Known limitations

- **A conversation open in another terminal cannot be opened here.** Two processes on one session log is a thing the harness refuses, and rightly: clicking a Code row whose terminal is still running elsewhere — another window of the app, or a terminal an unclean host exit left behind — shows that refusal in the column. Pressing **Code** is unaffected (it never revives a conversation on its own), and ending the other process (`/quit`, or closing its window) frees the row.
- **A restored terminal shows no scrollback.** See above: `dsh --resume` does not redraw a transcript, and this plugin runs the terminal's front door rather than reimplementing it.
- **Search results carry no mode dot.** The dots are painted on the browsing rows; a search result is a two-line stack that already names its workspace.
- **A conversation the web view has opened stops following its terminal's name.** Opening a Code row makes the web host resume that session in its own process, and from then on it lists a name folded from its own copy — which the terminal's later writes never reach. Renames made in the terminal after that show up on the next reload. Nothing a plugin can reach retires that copy; it belongs to the host.

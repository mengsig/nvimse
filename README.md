# nvimse

`nvimse` — **No Vibing In My Shitty (VSCode) Editor.** A faithful port of [`nvime`](../nvime), the Neovim discipline plugin, dragged into VS Code under protest. The AI keeps its hands off your code until you tell it exactly where, how, and why — then it does that and not one keystroke more. No sprawl. No mystery edits. No drive-by refactors. No hallucinated helpers. No "oops, I rewrote your repo.". No bullshit... This is your editor — the model is a guest, and guests don't touch the knives.

> **A note on the venue.** This is the same engine as `nvime`, shipped where the mouse-clickers live. `nvime` reviews a diff with `ga`/`gb` under your fingers without your hand ever leaving home row. `nvimse` reviews the same diff after you've reached for the trackpad, found the CodeLens, squinted, and clicked "✓ Accept." The patches are byte-for-byte identical. The latency between *deciding* and *doing* is not. We measured the agent. We could not measure the modal-editing muscle memory you gave up to read this. nvim > vscode. The benchmark below is the one place they tie — and that's only because `nvimse` literally runs `nvime`'s prompts.

It drives **Claude Code** and **Codex CLI** through explicit engineering lanes:

- **review/docs** — roam the repo, read shell/tests, write Markdown — no code edits
- **ask** — read-only Q&A about a selection or the enclosing function; the blade with its hands tied
- **edit** — one range, one file, written intent or it doesn't move
- **generation** — fill blank ranges or non-code files
- **plan** — the agent drafts a structured roadmap (`.nvime/plans/<id>/plan.json` + `plan.md`); you execute it step-by-step, and code lands only where you approved the shape
- **rationalized patches** — every edit ships a one-line `RATIONALE:` (bug → patch → why) in the diff banner before you accept
- **pre-accept verify lane** — parse + configured linters run against the proposed content; parse errors block silent accept (force-accept overrides and writes a `verify_force` audit event)
- **devil's-advocate critic** — opt-in second pass returns APPROVE / FLAG / REJECT — advisory, never blocks. Default-on for plans
- **Big Change** — let the agent build a whole feature autonomously in an isolated git worktree, then prove you understand every semantic block before it merges

## Why this exists

Same reason `nvime` exists: agents are happy to "help" by quietly rewriting half your repo. nvimse confines them to lanes, makes every proposed change a reviewable block, attaches a rationale and a risk read to it, and records who-wrote-what so your `git blame` doesn't lie. The discipline is the product. The editor is incidental — which is why we ported it to the editor that needed the discipline most.

## Parity with nvime

The thing that determines whether an AI coding tool is any *good* — its actual fix rate — lives in three places, and nvimse reproduces all three character-for-character from `nvime`:

1. the verbatim lane prompts (edit / ask / plan / critic / perf / quick),
2. the exact provider CLI argv per lane,
3. the `NVIME_DIFF` / `NVIME_REPLACEMENT` / `NVIME_NO_CHANGE` protocol parser and diff engine.

Because those are editor-agnostic, `nvime`'s own benchmark harness is reusable. Run it:

```sh
npm run build
node dist/bench/harness.js --provider claude --configs edit
```

On `nvime`'s 22-fixture correctness suite, against the real `claude` CLI:

| lane | result |
|------|--------|
| edit (exact text match) | **20–21 / 22** per run |
| edit (behavior parity¹) | **22 / 22** |
| ask (bug-found, no patch leak) | **3 / 3** sampled |

¹ Two or three of the hardest fixtures (`10_harder_logic`, `17_long_function_subtle_bug`, `20_graph_cycle_detection`) flip between exact-pass and exact-miss run to run — pure LLM stochasticity on problems with multiple valid solutions, not a port defect. `20_graph_cycle_detection`, for example, gets a recursion-stack + visited fix that is behaviorally identical to the canonical answer across every test case. This is precisely why `nvime` itself scores those fixtures with a behavior-parity rescore rather than text equality: the agent, the prompts, and the parser are the same, so the numbers are the same.

The offline diff engine is locked by **76 unit tests** (`npm test`), including replaying all 22 fixtures through the parser/applier and asserting the produced file matches `expected`.

## Install

Requires VS Code 1.85+, Node 18+, and at least one of the `claude` / `codex` CLIs on your `PATH`.

```sh
npm install
npm run build           # bundles dist/extension.js + dist/mcp/server.js
```

Then load the folder as an extension (F5 in the Extension Development Host, or package with `vsce package` and install the `.vsix`).

## Commands

Everything is under the `nvimse:` command palette prefix.

| Command | What it does | Keybinding |
|---|---|---|
| `nvimse: Command Center` | dashboard — sessions, running state, action rows | `ctrl+k space` |
| `nvimse: Chat Conversations` | general review/docs chat (one webview per conversation) | `ctrl+k ctrl+c` |
| `nvimse: Ask About Selection / Function` | read-only Q&A on the selection or enclosing symbol | `ctrl+k ctrl+a` |
| `nvimse: Edit Selection / Function` | reviewed patch for one range | `ctrl+k ctrl+e` |
| `nvimse: Quick Fix` | minimal no-tools patch worker | `ctrl+k ctrl+f` |
| `nvimse: Accept / Reject Diff Block` | resolve the inline diff, block by block (force variants override conflicts) | `ctrl+k a` / `ctrl+k r` |
| `nvimse: Accept All / Reject All` | bulk resolve | `ctrl+k shift+a` / `ctrl+k shift+r` |
| `nvimse: Open Diff Review Workspace` | two-pane native diff (proposed ⟷ live) | — |
| `nvimse: Plans` / `New Plan` | draft + execute structured plans step-by-step | — |
| `nvimse: Big Change` | autonomous feature build + forced-comprehension review | — |
| `nvimse: Recap Changes` | reverse "explain my git diff" into a `plan.md` narrative | — |
| `nvimse: PR Sidecar` | render `.nvime/pr.md` — reviewer-facing AI-attribution summary | — |
| `nvimse: Token + Cost Usage` | per-lane / per-day usage and cost | — |
| `nvimse: Show Attribution for Line` | which plan/step/provider authored the line under the cursor | — |
| `nvimse: Git Hooks` | install/uninstall the `prepare-commit-msg` co-author hook | — |
| `nvimse: Policy Rules` | per-path lane rules (`.nvime/policy.json`) | — |
| `nvimse: MCP Servers` | manage the merged MCP config + the bundled self-server | — |
| `nvimse: Check Health` | provider executables, git root, plans, guard events | — |
| `nvimse: Cancel / Disable / Enable` | operational controls | — |

### Default keybindings (chords)

**Every chord starts with `ctrl+k`** — press `ctrl+k` first, then the key(s) below:

- `space` — command center
- in an active diff: `a` accept · `shift+a` accept-all · `r` reject · `shift+r` reject-all · `]` / `[` next/prev block
- `ctrl+e` — edit · `ctrl+a` — ask · `ctrl+f` — quick fix · `ctrl+c` — chat

(In `nvime` these are one `<leader>n` namespace and you never touch a chord. We know. We're sorry.)

## Inline diff review

A generated patch becomes a `DiffSession` rendered in the target file:

- per-block **CodeLenses** — `✓ Accept` / `✗ Reject` — carrying the `RATIONALE:`, the risk read (`risk medium · +12 −3 · ai 18%`), and the critic verdict,
- line **decorations** marking pending / conflict blocks,
- an on-demand **two-pane workspace** (`nvimse: Open Diff Review Workspace`) showing the full proposed result against the live file.

Accepting a block applies it to the live file and records an attribution entry anchored to the accepted text content (so it survives later edits that shift line numbers). Before applying, nvimse compares the live slice with the original lines the agent reviewed — if they drifted, the block is marked a **conflict** instead of silently overwriting, and only a force-accept overrides it (which writes a `block_force_applied` audit event).

## Big Change

`nvimse: Big Change` runs the full lifecycle: pick a difficulty (`vibe` / `easy` / `medium` / `extreme`) → write a structured brief → the agent interrogates you with clarifying decisions and writes a spec → on approval it builds the feature **full-auto inside an isolated detached git worktree** (your tree is never touched) → it groups its own diff into semantic blocks → you `approve` each block and **explain what it does**, and the agent grades your explanation against the difficulty threshold (40 / 70 / 90%) → once every block clears, **merge** applies the work as unstaged changes on a fresh branch. Self-evident blocks (imports, docs, comments, version bumps) auto-clear on `easy`/`medium`.

## Configuration

All settings live under `nvimse.*` (see the Settings UI). Defaults are usable without configuration. Highlights:

- `nvimse.provider` — `claude` (default) or `codex`
- `nvimse.diff.devilsAdvocate` — run the critic on edit diffs (default off; plans default on via `nvimse.plan.devilsAdvocate`)
- `nvimse.verify.enabled` / `blockOnParseError` — pre-accept verification gate
- `nvimse.risk.confirmOnForceHigh` — confirm before force-accepting high-risk diffs
- `nvimse.review.allow{Shell,Web,MarkdownWrites}` / `nvimse.selection.allow{Shell,Web}` — tool permissions per lane
- `nvimse.testLoop.*` — after-diff test feedback loop (off by default)
- `nvimse.mcp.exposeSelf` — expose the bundled nvime MCP server (attribution/plans/usage/git/verify tools) to the providers

## State

Per-project state lives in `.nvime/` inside your git root (or `~/.local/state/nvime/` outside a repo):

- `audit.jsonl` — every agent run, gate, and forced action
- `attribution.json` — content-anchored ledger of who wrote what
- `usage.json` — token + cost accounting
- `plans/<id>/` — plan.json + plan.md
- `policy.json` — per-path lane rules
- `pr.md` — reviewer sidecar

## Test

```sh
npm test                                                       # 76 unit tests (parser, diff engine, argv + prompt parity)
node dist/bench/harness.js --provider claude --configs edit    # live agent-performance bench vs the real CLI
```

---

It cannot stop a hostile extension, a renamed binary, or an external terminal. It is an editor-discipline tool, not a security sandbox. It prevents accidental YOLO inside normal nvimse paths. And it works in VS Code now, so you've run out of excuses. (You should still use `nvime`.)

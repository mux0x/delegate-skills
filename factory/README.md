# Factory PoC layer

Thin Factory-side modules over the relays. The relays keep their `delegate-relay.result.v1`
contract; everything Factory-specific is opt-in.

| Module | Job |
| --- | --- |
| `profiles.mjs` | Load and validate trusted worker profiles (`factory.workers.v1`); strip paid-API and foreign-profile env |
| `dispatch.mjs` | Map one profile + mode (`implement` / `review`) to relay flags and run it |
| `git-guard.mjs` | Snapshot refs, HEAD, git config and hooks before a run; verify only the ticket branch fast-forwarded |
| `capacity.mjs` | Quota telemetry from `claude -p /usage`, `codex app-server account/rateLimits/read`, and relay results; dispatch gate |
| `forge.mjs` | `gh` wrapper pinned to one repo; create-once draft PR, ready, comment. No merge operation exists |
| `harness.mjs` | One ticket: approval → dependency (merged only) → branch → implement → guard → tests → push → draft PR → review per head SHA → freshness → ready |

```bash
node test/factory/contract.mjs                       # 111 mock contract checks, no model calls
node factory/dispatch.mjs --profiles <workers.json> --worker claude-a --mode implement \
  --cd <workspace> --brief <brief.md> --out-dir <dir>
node factory/capacity.mjs claude "$(command -v claude)" [<config-dir>]
node factory/capacity.mjs codex  "$(command -v codex)"  [<codex-home>]
node factory/harness.mjs --ticket <ticket.json> --state-dir <dir>
```

`FACTORY_CRASH_AT=after-implement-before-checkpoint|after-push-before-checkpoint|after-pr-before-checkpoint|after-review-before-checkpoint`
simulates a crash between a side effect and its checkpoint.

# Factory PoC layer

Thin Factory-side modules over the relays. The relays keep their `delegate-relay.result.v1`
contract; everything Factory-specific is opt-in.

| Module | Job |
| --- | --- |
| `profiles.mjs` | Load and validate trusted worker profiles (`factory.workers.v1`); strip paid-API and foreign-profile env |
| `dispatch.mjs` | Map one profile + mode (`implement` / `review`) to relay flags and run it; Codex skill policy; capacity read |
| `skills.mjs` | Codex skill discovery through the App Server (`skills/list`, no inference) and the `skills.config` disable list |
| `git-guard.mjs` | Snapshot refs, HEAD, git config and hooks before a run; verify only the ticket branch moved |
| `git-broker.mjs` | Trusted commit: guard check, change-set policy (protected paths, symlinks, size, credential shapes), one commit per run, idempotent |
| `test-runner.mjs` | Project tests in a throwaway container: workspace only, `.git` read-only, no network, read-only root, no capabilities |
| `review.mjs` | Review inputs from the Factory: head-pinned read-only snapshot, trusted diff, requirements; a separate clone for debate-review |
| `capacity.mjs` | Quota telemetry from `claude -p /usage`, `codex app-server account/rateLimits/read`, and relay results; dispatch gate |
| `forge.mjs` | `gh` wrapper pinned to one repo; create-once draft PR, ready, comment. No merge operation exists |
| `harness.mjs` | One ticket: approval → dependency (merged into base only) → branch → implement → broker commit → container tests → push → draft PR → review per head SHA → freshness → ready |

Implementers never commit: their sandboxes keep `.git` read-only, the brief replaces Matt's final
"commit your work" step with a `FACTORY_COMMIT: <subject>` line, and `git-broker.mjs` commits.

```bash
node test/factory/contract.mjs                       # mock contract checks, no model calls (needs Docker for the container groups)
node factory/dispatch.mjs --profiles <workers.json> --worker claude-a --mode implement \
  --cd <workspace> --brief <brief.md> --out-dir <dir>
node factory/capacity.mjs claude "$(command -v claude)" [<config-dir>]
node factory/capacity.mjs codex  "$(command -v codex)"  [<codex-home>]
node factory/harness.mjs --ticket <ticket.json> --state-dir <dir>
```

`FACTORY_CRASH_AT=after-implement-before-checkpoint|after-commit-before-checkpoint|during-tests|after-push-before-checkpoint|after-pr-before-checkpoint|before-review|after-review-before-checkpoint`
simulates a crash between a side effect and its checkpoint.

Ticket fields beyond the PoC basics: `testImage` (default `node:22-alpine`), `testTimeoutMs`, `protectedPaths`,
`capacityGate`, `maxInterruptions`, `maxReviewErrors`, `dependencyBase`, `review.gateWorkers`, `prHeadWaitMs`.
Worker fields: `skillsHome` (Codex), `denyRead` (Claude).

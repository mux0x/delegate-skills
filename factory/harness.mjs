#!/usr/bin/env node
// Mini Factory: one approved ticket → one branch → one PR, checkpointed after every side effect.
//   node factory/harness.mjs --ticket <ticket.json> --state-dir <dir>
// Not a scheduler: it runs one ticket to PR_READY (or a stop state) and never merges.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch } from "./dispatch.mjs";
import { makeForge } from "./forge.mjs";
import { git, snapshot, verify } from "./git-guard.mjs";
import { loadProfiles, workerEnv } from "./profiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function crashPoint(label) {
  if (process.env.FACTORY_CRASH_AT === label) {
    process.stderr.write(`harness: simulated crash at ${label}\n`);
    process.exit(137);
  }
}

function store(stateDir, id) {
  const file = join(stateDir, `${id}.json`);
  const load = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : null);
  const save = (state) => {
    state.updatedAt = new Date().toISOString();
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
  };
  return { file, load, save };
}

const factoryContext = (ticket, state) => `
Factory context (set by the Factory, not negotiable):
- You are on branch ${state.branch}, created for ticket ${ticket.id}. Commit your work on this branch only.
- Do not push, open or edit pull requests, switch or create branches, or rewrite history; the Factory owns those.
- Pre-agreed test seams: ${ticket.seams.join("; ")}.
- Code-review fixed point: ${state.baseSha}.
- No human is available during this run. Where a skill says to ask the user, use the ticket's stated decisions. If you are genuinely blocked, stop and report BLOCKED with the reason.
`;

export function implementBrief(ticket, state, provider) {
  const invoke = provider === "claude" ? "/mattpocock-skills:implement" : "$implement";
  return `${invoke} ${ticket.issue}\n${factoryContext(ticket, state)}`;
}

function remediationBrief(ticket, state, reason) {
  return `Remediation round ${state.remediationRounds} for ticket ${ticket.id} on the same branch.\n${reason}\nFix the cause, run the tests, and commit on ${state.branch}. Keep the same branch; the Factory updates the existing PR.\n${factoryContext(ticket, state)}`;
}

function runTests(ticket, repo) {
  const [cmd, ...args] = ticket.testCommand;
  const run = spawnSync(cmd, args, { cwd: repo, encoding: "utf8", env: workerEnv(), timeout: 300_000 });
  return { passed: run.status === 0, exitCode: run.status, tail: `${run.stdout}${run.stderr}`.split("\n").slice(-30).join("\n") };
}

async function implementStep(ctx, kind, brief) {
  const { ticket, state, save, repo, stateDir } = ctx;
  const round = state.runs.length;
  const outDir = join(stateDir, ticket.id, `${kind}-${round}`);
  const pending = state.pendingRun;
  let run;
  if (pending && existsSync(join(pending.outDir, "result.json"))) {
    run = { result: JSON.parse(readFileSync(join(pending.outDir, "result.json"), "utf8")), adopted: true };
  } else {
    const guardBefore = snapshot(repo);
    state.pendingRun = { kind, outDir, guardBefore, startedAt: new Date().toISOString() };
    save(state);
    mkdirSync(outDir, { recursive: true });
    const briefPath = join(outDir, "factory-brief.md");
    writeFileSync(briefPath, brief);
    const session = kind === "remediate" ? state.runs.findLast((r) => r.sessionId)?.sessionId ?? null : null;
    run = await dispatch({ profilesPath: ticket.profiles, workerId: ticket.implementer, mode: "implement", cd: repo, brief: briefPath, outDir, session });
  }
  crashPoint(`after-${kind}-before-checkpoint`);
  const guard = verify(repo, state.pendingRun.guardBefore, { branch: state.branch });
  const result = run.result;
  state.runs.push({
    kind, outDir: state.pendingRun.outDir, status: result?.status ?? "no_result", adopted: Boolean(run.adopted),
    sessionId: result?.sessionId ?? result?.threadId ?? null, commits: guard.commits, violations: guard.violations, dirty: guard.dirty,
  });
  state.pendingRun = null;
  if (!result || result.status !== "completed") return stop(ctx, "BLOCKED", `implementer ${result?.status ?? "wrote no result"}`);
  if (!guard.ok) return stop(ctx, "BLOCKED", `git guard: ${guard.violations.join("; ")}`);
  if (!guard.commits.length) return stop(ctx, "BLOCKED", "implementer made no commit on the ticket branch");
  if (guard.dirty.length) return stop(ctx, "BLOCKED", `uncommitted changes left behind: ${guard.dirty.join(", ")}`);
  save(state);
  return true;
}

function stop(ctx, phase, reason) {
  ctx.state.phase = phase;
  ctx.state.reason = reason;
  ctx.save(ctx.state);
  return false;
}

async function reviewHead(ctx, head) {
  const { ticket, state, repo, stateDir } = ctx;
  if (state.reviews[head]) return state.reviews[head];
  const outDir = join(stateDir, ticket.id, `review-${head.slice(0, 12)}`);
  const review = ticket.review.mode === "debate" ? debateReview(ctx, outDir) : await singleReview(ctx, outDir);
  crashPoint("after-review-before-checkpoint");
  state.reviews[head] = { ...review, at: new Date().toISOString(), outDir };
  ctx.save(state);
  return state.reviews[head];
}

function debateReview(ctx, outDir) {
  const { ticket, state, repo } = ctx;
  const script = join(ticket.reviewSkillsDir, "skills", "debate-review", "scripts", "review-pr.mjs");
  const args = [script, "--out-dir", outDir, "--timeout", ticket.review.timeout ?? "20m", "--repo-dir", repo];
  if (ticket.review.target === "pr") args.splice(1, 0, state.pr.url);
  else args.push("--local", "--base", state.baseSha);
  const runFile = join(outDir, "run.json");
  const prior = existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) : null;
  let exitCode = 0;
  if (!(prior && prior.posted && (prior.printOnly || prior.postResult))) {
    const run = spawnSync(process.execPath, args, {
      cwd: repo, encoding: "utf8", timeout: 3_600_000,
      env: { ...workerEnv(), DELEGATE_SKILLS_DIR: join(ROOT, "skills"), XDG_CONFIG_HOME: ticket.review.fleetConfigHome },
    });
    writeFileSync(join(dirname(outDir), `review-${state.headSha.slice(0, 12)}.log`), `${run.stdout}\n${run.stderr}`);
    exitCode = run.status;
  }
  if (exitCode === 3 && !existsSync(runFile)) return { verdict: "unknown", blocking: [], note: "head already reviewed elsewhere" };
  if (!existsSync(runFile)) return { verdict: "error", blocking: [], note: `debate-review exited ${exitCode} without run.json` };
  const log = JSON.parse(readFileSync(runFile, "utf8"));
  if (!log.posted) return { verdict: "error", blocking: [], note: `debate-review exited ${exitCode}: ${log.error ?? "no review produced"}` };
  const main = new Map((log.stages.main?.doc?.findings ?? []).map((f) => [f.id, f]));
  for (const f of log.stages.debate?.doc?.new_findings ?? []) main.set(f.id, f);
  const final = log.stages.final?.doc?.findings ?? [];
  const blocking = final.filter((f) => f.status === "agreed" && (f.severity ?? main.get(f.id)?.severity) === "blocking").map((f) => f.id);
  return { verdict: blocking.length ? "changes-requested" : "pass", blocking, mode: "debate", url: log.postResult?.url ?? null };
}

export function singleReview(ctx, outDir) {
  const { ticket, state, repo } = ctx;
  const skill = readFileSync(join(ticket.mattSkillsDir, "skills", "engineering", "code-review", "SKILL.md"), "utf8");
  const brief = `You are running Matt Pocock's code-review skill as a read-only single reviewer. Its instructions follow verbatim between the markers. Adaptation: you have no sub-agent tool, so run the Standards axis and then the Spec axis yourself, one after the other, keeping their reports separate.\nFixed point: ${state.baseSha}. Spec: ${ticket.issue} (read it from the repository).\n\n<<<SKILL\n${skill}\nSKILL>>>\n\nAfter the two reports, end with exactly one fenced json block: {"schema":"factory.single-review.v1","head":"${state.headSha}","verdict":"pass|changes-requested","findings":[{"axis":"standards|spec","severity":"blocking|non-blocking","claim":"..."}]}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "brief.md"), brief);
  return dispatch({ profilesPath: ticket.profiles, workerId: ticket.review.worker, mode: "review", cd: repo, brief: join(outDir, "brief.md"), outDir })
    .then(({ result }) => {
      const blocks = [...(result?.finalMessage ?? "").matchAll(/```json\s*([\s\S]*?)```/g)];
      let doc = null;
      try { doc = JSON.parse(blocks.at(-1)[1]); } catch { doc = null; }
      if (!doc || doc.schema !== "factory.single-review.v1") return { verdict: "error", blocking: [], mode: "single", readOnlyViolation: result?.readOnlyViolation ?? null };
      const blocking = doc.findings.filter((f) => f.severity === "blocking").map((f) => f.claim);
      return { verdict: blocking.length ? "changes-requested" : "pass", blocking, mode: "single", readOnlyViolation: result?.readOnlyViolation ?? null };
    });
}

function freshness(repo, ticket) {
  git(repo, ["fetch", "--quiet", ticket.remote, ticket.base]);
  const baseTip = git(repo, ["rev-parse", "FETCH_HEAD"]);
  let current = true;
  try { git(repo, ["merge-base", "--is-ancestor", baseTip, "HEAD"]); } catch { current = false; }
  const merge = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "merge-tree", "--write-tree", baseTip, "HEAD"], { cwd: repo, encoding: "utf8" });
  return { baseTip, current, conflicts: merge.status !== 0 };
}

export async function runTicket(ticketPath, stateDir) {
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
  const repo = resolve(ticket.repo);
  mkdirSync(stateDir, { recursive: true });
  const { load, save } = store(stateDir, ticket.id);
  const state = load() ?? { ticket: ticket.id, phase: "NEW", branch: `factory/${ticket.id}`, runs: [], reviews: {}, remediationRounds: 0, pendingRun: null, events: [] };
  const ctx = { ticket, state, save, repo, stateDir };
  const forge = ticket.forge ? makeForge({ gh: ticket.forge.gh, repo: ticket.forge.repo, env: { ...process.env, ...(ticket.forge.env ?? {}) } }) : null;

  if (!ticket.approval || ticket.approval.approved !== true || !ticket.approval.by) return stop(ctx, "AWAITING_APPROVAL", "no explicit approval on the ticket");
  loadProfiles(ticket.profiles);
  for (const dep of ticket.dependsOn ?? []) {
    const depState = store(stateDir, dep).load();
    const pr = depState?.pr ? forge.view(depState.pr.number) : null;
    if (!pr || pr.state !== "MERGED") return stop(ctx, "BLOCKED_DEPENDENCY", `${dep} is ${pr ? `${pr.state}${pr.isDraft ? " (draft)" : ""}` : "not started"}; dependencies count only once merged`);
  }

  if (state.phase === "NEW" || state.phase === "AWAITING_APPROVAL" || state.phase === "BLOCKED_DEPENDENCY") {
    git(repo, ["fetch", "--quiet", ticket.remote, ticket.base]);
    state.baseSha = git(repo, ["rev-parse", "FETCH_HEAD"]);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`], { cwd: repo }).status === 0;
    git(repo, exists ? ["switch", "--quiet", state.branch] : ["switch", "--quiet", "-c", state.branch, state.baseSha]);
    state.phase = "IMPLEMENTING";
    save(state);
  }

  if (state.phase === "IMPLEMENTING") {
    const provider = loadProfiles(ticket.profiles).workers[ticket.implementer].provider;
    if (!(await implementStep(ctx, "implement", implementBrief(ticket, state, provider)))) return false;
    state.phase = "TESTING";
    save(state);
  }

  for (;;) {
    if (state.phase === "REMEDIATING") {
      if (state.remediationRounds > (ticket.maxRemediationRounds ?? 1)) return stop(ctx, "BLOCKED", "remediation budget exhausted");
      if (!(await implementStep(ctx, "remediate", remediationBrief(ticket, state, state.remediationReason)))) return false;
      state.phase = "TESTING";
      save(state);
    }
    if (state.phase === "TESTING") {
      state.headSha = git(repo, ["rev-parse", "HEAD"]);
      const tests = runTests(ticket, repo);
      state.tests = { ...tests, headSha: state.headSha };
      if (!tests.passed) {
        state.remediationRounds += 1;
        state.remediationReason = `Tests failed (exit ${tests.exitCode}):\n${tests.tail}`;
        state.phase = "REMEDIATING";
        save(state);
        continue;
      }
      state.phase = "PUSHING";
      save(state);
    }
    if (state.phase === "PUSHING") {
      git(repo, ["push", "--quiet", ticket.remote, `refs/heads/${state.branch}:refs/heads/${state.branch}`]);
      crashPoint("after-push-before-checkpoint");
      state.pushedSha = state.headSha;
      state.phase = "PR";
      save(state);
    }
    if (state.phase === "PR") {
      if (!state.pr) {
        const pr = forge.findPr(state.branch) ?? forge.createDraftPr({ head: state.branch, base: ticket.base, title: `${ticket.id}: ${ticket.title}`, body: `Factory ticket ${ticket.id}\n\nIssue: ${ticket.issue}\n\nOpened as draft by the Factory. Merge is manual.` });
        crashPoint("after-pr-before-checkpoint");
        state.pr = { number: pr.number, url: pr.url };
      }
      state.phase = "REVIEWING";
      save(state);
    }
    if (state.phase === "REVIEWING") {
      const review = await reviewHead(ctx, state.headSha);
      if (review.verdict === "changes-requested") {
        state.remediationRounds += 1;
        state.remediationReason = `Review on ${state.headSha.slice(0, 12)} requested changes: ${review.blocking.join("; ")}`;
        state.phase = "REMEDIATING";
        save(state);
        continue;
      }
      if (review.verdict !== "pass") return stop(ctx, "BLOCKED", `review ${review.verdict}: ${review.note ?? ""}`);
      state.phase = "FRESHNESS";
      save(state);
    }
    if (state.phase === "FRESHNESS") {
      const fresh = freshness(repo, ticket);
      state.freshness = fresh;
      if (!fresh.current || fresh.conflicts) return stop(ctx, "STALE_OR_CONFLICT", `branch ${fresh.current ? "has conflicts" : "is behind"} ${ticket.base}`);
      const pr = forge.view(state.pr.number);
      if (pr.headRefOid !== state.headSha) return stop(ctx, "BLOCKED", `PR head ${pr.headRefOid} is not the tested head ${state.headSha}`);
      if (pr.isDraft) forge.markReady(state.pr.number);
      state.phase = "AWAITING_OWNER_MERGE";
      state.reason = "PR ready; merge is manual";
      save(state);
      return true;
    }
    if (state.phase === "AWAITING_OWNER_MERGE") return true;
    return false;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => args[args.indexOf(flag) + 1];
  const ok = await runTicket(get("--ticket"), resolve(get("--state-dir")));
  const state = JSON.parse(readFileSync(join(resolve(get("--state-dir")), `${JSON.parse(readFileSync(get("--ticket"), "utf8")).id}.json`), "utf8"));
  console.log(JSON.stringify({ ok, phase: state.phase, reason: state.reason ?? null, pr: state.pr ?? null, headSha: state.headSha ?? null }, null, 2));
  process.exit(ok ? 0 : 1);
}

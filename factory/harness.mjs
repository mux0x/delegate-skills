#!/usr/bin/env node
// Mini Factory: one approved ticket → one branch → one PR, checkpointed after every side effect.
//   node factory/harness.mjs --ticket <ticket.json> --state-dir <dir>
// Not a scheduler: it runs one ticket to PR_READY (or a stop state) and never merges.
// Implementers only edit files; the Factory commits (git-broker), runs tests in a container
// (test-runner), pushes, opens the PR and prepares review inputs (review).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capacityFor, dispatch } from "./dispatch.mjs";
import { makeForge } from "./forge.mjs";
import { brokerCommit, commitMessage } from "./git-broker.mjs";
import { git, snapshot, verify } from "./git-guard.mjs";
import { loadProfiles, workerEnv } from "./profiles.mjs";
import { checkSnapshot, prepareSnapshot, reviewClone, snapshotBrief } from "./review.mjs";
import { runTestsIsolated } from "./test-runner.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_TEST_IMAGE = "node:22-alpine";

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
- You are on branch ${state.branch}, created for ticket ${ticket.id}. Edit files only.
- Git metadata is read-only in your sandbox. Do not run git add, git commit, git push, gh, or switch branches. The Factory commits your finished work for you; this replaces the skill's final "commit your work" step.
- When the work is complete and the full test suite passes, end your final message with one line: FACTORY_COMMIT: <conventional commit subject>
- Pre-agreed test seams: ${ticket.seams.join("; ")}.
- Code-review fixed point: ${state.baseSha}. Your changes are uncommitted, so review them with \`git status\` and \`git diff ${state.baseSha}\` (new files show as untracked).
- No human is available during this run. Where a skill says to ask the user, use the ticket's stated decisions. If you are genuinely blocked, stop and report BLOCKED with the reason.
`;

export function implementBrief(ticket, state, provider) {
  const invoke = provider === "claude" ? "/mattpocock-skills:implement" : provider === "opencode" ? "Load the `implement` skill with your skill tool, then follow it for" : "$implement";
  return `${invoke} ${ticket.issue}\n${factoryContext(ticket, state)}`;
}

function remediationBrief(ticket, state, reason) {
  return `Remediation round ${state.remediationRounds} for ticket ${ticket.id} on the same branch.\n${reason}\nFix the cause and run the tests. Keep the same branch; the Factory commits your fix and updates the existing PR.\n${factoryContext(ticket, state)}`;
}

function resumeBrief(ticket, state) {
  return `Your previous run on ticket ${ticket.id} was interrupted (${state.interruption.status}) before it finished. The workspace still holds the edits you had made; the Factory has not committed anything since. Continue the same work from where you stopped, run the tests, and finish as instructed.\n${factoryContext(ticket, state)}`;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sessionFromEvents = (outDir) => {
  const file = join(outDir, "events.jsonl");
  if (!existsSync(file)) return null;
  const match = /"(?:session_id|thread_id)":"([0-9a-f-]{20,})"/.exec(readFileSync(file, "utf8"));
  return match ? match[1] : null;
};

async function implementStep(ctx, requestedKind, requestedBrief) {
  let kind = requestedKind;
  let brief = requestedBrief;
  const { ticket, state, save, repo, stateDir } = ctx;
  let pending = state.pendingRun;
  let run;
  if (pending && existsSync(join(pending.outDir, "result.json"))) {
    run = { result: JSON.parse(readFileSync(join(pending.outDir, "result.json"), "utf8")), adopted: true };
  } else if (pending && pending.relayPid && alive(pending.relayPid)) {
    return stop(ctx, "RUN_IN_PROGRESS", `relay ${pending.relayPid} from an earlier Factory process is still running`);
  } else {
    if (pending) {
      // The Factory died while the relay was running and the relay died without a result:
      // record it as lost and resume its session rather than starting the work over.
      const lost = { kind: pending.kind, outDir: pending.outDir, status: "lost", sessionId: sessionFromEvents(pending.outDir), commit: null };
      state.runs.push(lost);
      state.pendingRun = null;
      if (lost.sessionId) {
        state.interruption = { status: "lost", sessionId: lost.sessionId, at: new Date().toISOString(), resumePhase: state.phase };
        kind = `${pending.kind.replace(/-resume$/, "")}-resume`;
        brief = resumeBrief(ticket, state);
      }
      save(state);
    }
    if (await capacityStop(ctx, [ticket.implementer])) return false;
    const round = state.runs.length;
    const outDir = join(stateDir, ticket.id, `${kind}-${round}`);
    const session = kind === "implement" ? null : state.runs.findLast((r) => r.sessionId)?.sessionId ?? null;
    if (kind.endsWith("-resume") && !session) return stop(ctx, "BLOCKED", "interrupted run left no session to resume");
    state.pendingRun = { kind, runId: `${ticket.id}/${kind}-${round}`, outDir, guardBefore: snapshot(repo), startedAt: new Date().toISOString(), session };
    save(state);
    mkdirSync(outDir, { recursive: true });
    const briefPath = join(outDir, "factory-brief.md");
    writeFileSync(briefPath, brief);
    run = await dispatch({
      profilesPath: ticket.profiles, workerId: ticket.implementer, mode: "implement", cd: repo, brief: briefPath, outDir, session,
      onSpawn: (pid) => { state.pendingRun.relayPid = pid; save(state); },
    });
  }
  pending = state.pendingRun;
  kind = pending.kind;
  crashPoint(`after-${kind}-before-checkpoint`);
  const result = run.result;
  const sessionId = result?.sessionId ?? result?.threadId ?? sessionFromEvents(pending.outDir);
  const record = { kind, outDir: pending.outDir, status: result?.status ?? "no_result", adopted: Boolean(run.adopted), sessionId, resumedSession: pending.session ?? null, commit: null };
  if (!result || result.status !== "completed") {
    state.runs.push(record);
    state.pendingRun = null;
    const guard = verify(repo, pending.guardBefore, { branch: state.branch });
    if (!guard.ok) return stop(ctx, "BLOCKED", `git guard after ${record.status} run: ${guard.violations.join("; ")}`);
    state.interruptions = (state.interruptions ?? 0) + 1;
    if (sessionId && state.interruptions <= (ticket.maxInterruptions ?? 1)) {
      state.interruption = { status: record.status, sessionId, dirty: guard.dirty, at: new Date().toISOString(), resumePhase: state.phase };
      return stop(ctx, "INTERRUPTED", `implementer ${record.status}; rerun resumes session ${sessionId}`);
    }
    return stop(ctx, "BLOCKED", `implementer ${record.status}${sessionId ? "; interruption budget exhausted" : " with no session to resume"}`);
  }
  const committed = brokerCommit(repo, {
    branch: state.branch, guardBefore: pending.guardBefore, runId: pending.runId,
    message: commitMessage(result.finalMessage, `${kind === "implement" ? "feat" : "fix"}: ${ticket.id} ${ticket.title}`),
    protectedPaths: ticket.protectedPaths,
  });
  crashPoint("after-commit-before-checkpoint");
  record.commit = committed.commit ?? null;
  record.broker = { ok: committed.ok, adopted: committed.adopted ?? false, files: committed.files ?? [], reason: committed.reason ?? null };
  state.runs.push(record);
  state.pendingRun = null;
  if (!committed.ok) return stop(ctx, "BLOCKED", committed.reason);
  if (!committed.commit) return stop(ctx, "BLOCKED", "implementer finished without changing any file");
  save(state);
  return true;
}

// With ticket.capacityGate, every real dispatch first needs fresh measured headroom for each worker it
// will use; unreadable telemetry blocks just like low headroom.
async function capacityStop(ctx, workers) {
  if (ctx.ticket.capacityGate !== true) return false;
  for (const id of workers) {
    const check = await capacityFor(ctx.ticket.profiles, id);
    ctx.state.capacityChecks = [...(ctx.state.capacityChecks ?? []), { worker: id, state: check.gate.state, reason: check.gate.reason, at: new Date().toISOString() }];
    if (!check.gate.dispatch) {
      ctx.state.capacityResume = ctx.state.interruption ? "INTERRUPTED" : ctx.state.phase;
      return stop(ctx, check.gate.state, `${id}: ${check.gate.reason}`) || true;
    }
  }
  return false;
}

function stop(ctx, phase, reason) {
  ctx.state.phase = phase;
  ctx.state.reason = reason;
  ctx.save(ctx.state);
  return false;
}

async function runTests(ctx) {
  const { ticket, state, repo } = ctx;
  state.testRuns = state.testRuns ?? [];
  const attempt = state.testRuns.length + 1;
  const image = ticket.testImage ?? DEFAULT_TEST_IMAGE;
  if (process.env.FACTORY_CRASH_AT === "during-tests") {
    runTestsIsolated({ workspace: repo, command: ["node", "-e", "setInterval(()=>{},1000)"], image, label: ticket.id, attempt: `crash-${attempt}` });
    await new Promise((r) => setTimeout(r, 2500));
    crashPoint("during-tests");
  }
  const tests = await runTestsIsolated({ workspace: repo, command: ticket.testCommand, image, label: ticket.id, attempt, timeoutMs: ticket.testTimeoutMs ?? 300_000 });
  const entry = { attempt, headSha: state.headSha, at: new Date().toISOString(), ...tests };
  state.testRuns.push(entry);
  return entry;
}

async function reviewHead(ctx, head) {
  const { ticket, state, stateDir } = ctx;
  if (state.reviews[head]) return state.reviews[head];
  if (await capacityStop(ctx, ticket.review.mode === "debate" ? ticket.review.gateWorkers ?? [] : [ticket.review.worker])) return { verdict: "capacity", blocking: [], note: state.reason };
  const outDir = join(stateDir, ticket.id, `review-${head.slice(0, 12)}`);
  const review = ticket.review.mode === "debate" ? debateReview(ctx, outDir) : await singleReview(ctx, outDir);
  crashPoint("after-review-before-checkpoint");
  if (review.verdict === "error") {
    // An infrastructure failure is not a verdict: keep it out of the per-head cache so a rerun retries.
    state.reviewErrors = [...(state.reviewErrors ?? []), { ...review, head, at: new Date().toISOString(), outDir }];
    return review;
  }
  state.reviews[head] = { ...review, head, at: new Date().toISOString(), outDir };
  ctx.save(state);
  return state.reviews[head];
}

function debateReview(ctx, outDir) {
  const { ticket, state, repo, stateDir } = ctx;
  const script = join(ticket.reviewSkillsDir, "skills", "debate-review", "scripts", "review-pr.mjs");
  const clone = reviewClone(repo, { root: join(stateDir, "review-clones", ticket.id), remoteUrl: git(repo, ["remote", "get-url", ticket.remote]) });
  const args = [script, "--out-dir", outDir, "--timeout", ticket.review.timeout ?? "20m", "--repo-dir", clone];
  if (ticket.review.target === "pr") args.splice(1, 0, state.pr.url);
  else args.push("--local", "--base", state.baseSha);
  const runFile = join(outDir, "run.json");
  const prior = existsSync(runFile) ? JSON.parse(readFileSync(runFile, "utf8")) : null;
  let exitCode = 0;
  if (!(prior && prior.posted && (prior.printOnly || prior.postResult))) {
    const run = spawnSync(process.execPath, args, {
      cwd: clone, encoding: "utf8", timeout: 3_600_000,
      env: { ...workerEnv(), DELEGATE_SKILLS_DIR: join(ROOT, "skills"), XDG_CONFIG_HOME: ticket.review.fleetConfigHome },
    });
    writeFileSync(join(dirname(outDir), `review-${state.headSha.slice(0, 12)}.log`), `${run.stdout}\n${run.stderr}`);
    exitCode = run.status;
  }
  if (exitCode === 3 && !existsSync(runFile)) return { verdict: "unknown", blocking: [], note: "head already reviewed elsewhere" };
  if (!existsSync(runFile)) return { verdict: "error", blocking: [], note: `debate-review exited ${exitCode} without run.json` };
  const log = JSON.parse(readFileSync(runFile, "utf8"));
  if (!log.posted) return { verdict: "error", blocking: [], note: `debate-review exited ${exitCode}: ${log.error ?? "no review produced"}` };
  if (ticket.review.target === "pr" && log.pr?.head !== state.headSha) return { verdict: "error", blocking: [], note: `debate-review reviewed ${log.pr?.head}, not ${state.headSha}` };
  const main = new Map((log.stages.main?.doc?.findings ?? []).map((f) => [f.id, f]));
  for (const f of log.stages.debate?.doc?.new_findings ?? []) main.set(f.id, f);
  const final = log.stages.final?.doc?.findings ?? [];
  const describe = (f) => {
    const src = main.get(f.id) ?? {};
    return [f.id, src.title ?? f.title, src.body ?? src.detail ?? src.claim, src.path ? `(${src.path}${src.line ? `:${src.line}` : ""})` : ""].filter(Boolean).join(" ");
  };
  const blocking = final.filter((f) => f.status === "agreed" && (f.severity ?? main.get(f.id)?.severity) === "blocking").map(describe);
  return { verdict: blocking.length ? "changes-requested" : "pass", blocking, mode: "debate", reviewedHead: log.pr?.head ?? null, url: log.postResult?.url ?? null };
}

export async function singleReview(ctx, outDir) {
  const { ticket, state, repo } = ctx;
  const profiles = loadProfiles(ticket.profiles);
  const meta = prepareSnapshot(repo, { base: state.baseSha, head: state.headSha, issue: ticket.issue, root: join(profiles.workspaceRoot, ".factory-review", ticket.id) });
  const skill = readFileSync(join(ticket.mattSkillsDir, "skills", "engineering", "code-review", "SKILL.md"), "utf8");
  const brief = `You are running Matt Pocock's code-review skill as a read-only single reviewer. Its instructions follow verbatim between the markers. Adaptation: you have no sub-agent tool and no git, so run the Standards axis and then the Spec axis yourself, one after the other, keeping their reports separate, and use the diff and requirements supplied below instead of running git.\n\n<<<SKILL\n${skill}\nSKILL>>>\n\n${snapshotBrief(meta)}\n\nAfter the two reports, end with exactly one fenced json block: {"schema":"factory.single-review.v1","head":"${state.headSha}","verdict":"pass|changes-requested","findings":[{"axis":"standards|spec","severity":"blocking|non-blocking","claim":"..."}]}`;
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "brief.md"), brief);
  const { result } = await dispatch({ profilesPath: ticket.profiles, workerId: ticket.review.worker, mode: "review", cd: meta.src, brief: join(outDir, "brief.md"), outDir });
  const integrity = checkSnapshot(meta);
  const base = { mode: "single", snapshot: meta.dir, snapshotUnchanged: integrity.unchanged };
  if (!integrity.unchanged) return { ...base, verdict: "error", blocking: [], note: "review snapshot changed during the review" };
  const blocks = [...(result?.finalMessage ?? "").matchAll(/```json\s*([\s\S]*?)```/g)];
  let doc = null;
  try { doc = JSON.parse(blocks.at(-1)[1]); } catch { doc = null; }
  if (!doc || doc.schema !== "factory.single-review.v1") return { ...base, verdict: "error", blocking: [], note: `reviewer ${result?.status ?? "wrote no result"} without a verdict block` };
  if (doc.head !== undefined && doc.head !== state.headSha) return { ...base, verdict: "error", blocking: [], note: `verdict names head ${doc.head}` };
  const blocking = doc.findings.filter((f) => f.severity === "blocking").map((f) => f.claim);
  return { ...base, verdict: blocking.length ? "changes-requested" : "pass", blocking };
}

function freshness(repo, ticket) {
  git(repo, ["fetch", "--quiet", ticket.remote, ticket.base]);
  const baseTip = git(repo, ["rev-parse", "FETCH_HEAD"]);
  let current = true;
  try { git(repo, ["merge-base", "--is-ancestor", baseTip, "HEAD"]); } catch { current = false; }
  const merge = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "merge-tree", "--write-tree", baseTip, "HEAD"], { cwd: repo, encoding: "utf8" });
  return { baseTip, current, conflicts: merge.status !== 0 };
}

// A dependency counts only when its PR is merged into the required base and the merge commit
// is reachable from that base on the remote. Draft, ready and approved PRs never count.
function dependencyStatus(ticket, repo, depState, forge) {
  if (!depState?.pr) return { ok: false, why: "not started" };
  const pr = forge.view(depState.pr.number);
  if (pr.state !== "MERGED") return { ok: false, why: `${pr.state}${pr.isDraft ? " (draft)" : " (ready)"}` };
  const base = ticket.dependencyBase ?? ticket.base;
  if (pr.baseRefName !== base) return { ok: false, why: `merged into ${pr.baseRefName}, not ${base}` };
  git(repo, ["fetch", "--quiet", ticket.remote, base]);
  try { git(repo, ["merge-base", "--is-ancestor", pr.mergeCommit?.oid ?? "missing", "FETCH_HEAD"]); } catch { return { ok: false, why: `merge commit not on ${ticket.remote}/${base}` }; }
  return { ok: true, why: `merged as ${pr.mergeCommit.oid.slice(0, 12)}` };
}

export async function runTicket(ticketPath, stateDir) {
  const ticket = JSON.parse(readFileSync(ticketPath, "utf8"));
  const repo = resolve(ticket.repo);
  mkdirSync(stateDir, { recursive: true });
  const { load, save } = store(stateDir, ticket.id);
  const state = load() ?? { ticket: ticket.id, phase: "NEW", branch: `factory/${ticket.id}`, runs: [], reviews: {}, testRuns: [], remediationRounds: 0, pendingRun: null };
  const ctx = { ticket, state, save, repo, stateDir };
  const forge = ticket.forge ? makeForge({ gh: ticket.forge.gh, repo: ticket.forge.repo, env: { ...process.env, ...(ticket.forge.env ?? {}) } }) : null;

  if (!ticket.approval || ticket.approval.approved !== true || !ticket.approval.by) return stop(ctx, "AWAITING_APPROVAL", "no explicit approval on the ticket");
  loadProfiles(ticket.profiles);
  if (["CAPACITY_LOW", "CAPACITY_SYNC_REQUIRED", "RATE_LIMITED"].includes(state.phase)) state.phase = state.capacityResume;
  if (state.phase === "REVIEW_ERROR" || state.phase === "PR_HEAD_PENDING") state.phase = "REVIEWING";
  if (["NEW", "AWAITING_APPROVAL", "BLOCKED_DEPENDENCY"].includes(state.phase)) {
    for (const dep of ticket.dependsOn ?? []) {
      const status = dependencyStatus(ticket, repo, store(stateDir, dep).load(), forge);
      state.dependencyChecks = [...(state.dependencyChecks ?? []), { dep, ...status, at: new Date().toISOString() }];
      if (!status.ok) return stop(ctx, "BLOCKED_DEPENDENCY", `${dep} is ${status.why}; dependencies count only once merged into ${ticket.dependencyBase ?? ticket.base}`);
    }
    git(repo, ["fetch", "--quiet", ticket.remote, ticket.base]);
    state.baseSha = git(repo, ["rev-parse", "FETCH_HEAD"]);
    const exists = spawnSync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${state.branch}`], { cwd: repo }).status === 0;
    git(repo, exists ? ["switch", "--quiet", state.branch] : ["switch", "--quiet", "-c", state.branch, state.baseSha]);
    state.phase = "IMPLEMENTING";
    save(state);
  }

  if (state.phase === "INTERRUPTED") {
    const kind = state.interruption.resumePhase === "IMPLEMENTING" ? "implement-resume" : "remediate-resume";
    state.phase = state.interruption.resumePhase;
    save(state);
    if (!(await implementStep(ctx, kind, resumeBrief(ticket, state)))) return false;
    state.interruption = null;
    state.phase = "TESTING";
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
      const tests = await runTests(ctx);
      state.tests = tests;
      if (!tests.passed) {
        state.remediationRounds += 1;
        state.remediationReason = `Factory test run ${tests.attempt} on ${state.headSha.slice(0, 12)} ${tests.status} (exit ${tests.exitCode}). Output tail:\n${tests.tail}`;
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
      crashPoint("before-review");
      // GitHub updates a PR's head a few seconds after the push lands; wait for it, bounded.
      let pr = forge.view(state.pr.number);
      for (let waited = 0; pr.headRefOid !== state.headSha && waited < (ticket.prHeadWaitMs ?? 60_000); waited += ticket.prHeadPollMs ?? 5_000) {
        await new Promise((r) => setTimeout(r, ticket.prHeadPollMs ?? 5_000));
        pr = forge.view(state.pr.number);
      }
      if (pr.headRefOid !== state.headSha) return stop(ctx, "PR_HEAD_PENDING", `PR head ${pr.headRefOid} is not the tested head ${state.headSha} yet`);
      const review = await reviewHead(ctx, state.headSha);
      if (review.verdict === "changes-requested") {
        state.remediationRounds += 1;
        state.remediationReason = `Review of ${state.headSha.slice(0, 12)} requested changes. Blocking findings:\n- ${review.blocking.join("\n- ")}`;
        state.phase = "REMEDIATING";
        save(state);
        continue;
      }
      if (review.verdict === "capacity") return false;
      if (review.verdict === "error") {
        const errors = state.reviewErrors.filter((e) => e.head === state.headSha).length;
        return stop(ctx, errors < (ticket.maxReviewErrors ?? 2) ? "REVIEW_ERROR" : "BLOCKED", `review error ${errors} on ${state.headSha.slice(0, 12)}: ${review.note ?? ""}`);
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
      const gates = { testsPassedOnHead: state.tests?.passed === true && state.tests.headSha === state.headSha, reviewPassedOnHead: state.reviews[state.headSha]?.verdict === "pass", prHeadIsTested: pr.headRefOid === state.headSha };
      state.readyGates = gates;
      if (!Object.values(gates).every(Boolean)) return stop(ctx, "BLOCKED", `ready gates failed: ${JSON.stringify(gates)}`);
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

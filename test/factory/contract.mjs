#!/usr/bin/env node
// Factory contract tests: fake CLIs, disposable repos, zero model calls.
//   node test/factory/contract.mjs [--only <group,...>]
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dispatch, relayArgv } from "../../factory/dispatch.mjs";
import { loadProfiles, resolveWorker, workerEnv } from "../../factory/profiles.mjs";
import { snapshot, verify } from "../../factory/git-guard.mjs";
import { codexWindows, fromRelayResult, gate, parseClaudeUsage } from "../../factory/capacity.mjs";
import { runTicket } from "../../factory/harness.mjs";
import { brokerCommit, commitMessage } from "../../factory/git-broker.mjs";
import { dockerArgs, runTestsIsolated } from "../../factory/test-runner.mjs";
import { checkSnapshot, prepareSnapshot } from "../../factory/review.mjs";
import { skillOverrides } from "../../factory/skills.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..", "..");
const only = (() => {
  const at = process.argv.indexOf("--only");
  return at === -1 ? null : new Set(process.argv[at + 1].split(","));
})();

let failed = 0;
let passed = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "  ok " : "  FAIL"}  ${name}${!condition && detail ? `\n        ${detail}` : ""}`);
  if (condition) passed += 1; else failed += 1;
};
const pair = (args, flag, value) => {
  const at = args.indexOf(flag);
  return at !== -1 && args[at + 1] === value;
};
const sh = (cwd, cmd, args) => spawnSync(cmd, args, { cwd, encoding: "utf8" });
const g = (cwd, ...args) => {
  const run = sh(cwd, "git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args]);
  if (run.status !== 0) throw new Error(`git ${args.join(" ")}: ${run.stderr}`);
  return run.stdout.trim();
};

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "factory-contract-")));
const ws = join(scratch, "ws");
const conf = join(scratch, "conf");
const binDir = join(scratch, "bin");
for (const dir of [ws, conf, binDir, join(scratch, "profiles", "claude-b"), join(scratch, "profiles", "codex-home"), join(scratch, "plugins", "matt")]) mkdirSync(dir, { recursive: true });
copyFileSync(join(here, "fixtures", "fake-opencode.cjs"), join(binDir, "opencode"));
chmodSync(join(binDir, "opencode"), 0o755);
for (const name of ["claude-a", "claude-b", "codex"]) {
  copyFileSync(join(here, "fixtures", "fake-agent.cjs"), join(binDir, name));
  chmodSync(join(binDir, name), 0o755);
}
copyFileSync(join(here, "fixtures", "fake-gh.cjs"), join(binDir, "gh"));
chmodSync(join(binDir, "gh"), 0o755);
writeFileSync(join(conf, "mcp-claude.json"), JSON.stringify({ mcpServers: { mock: { command: process.execPath, args: ["/dev/null"] } } }));
writeFileSync(join(conf, "mcp-codex.json"), JSON.stringify({ servers: { mock: { command: process.execPath, args: ["/x/server.mjs"], enabledTools: ["echo"] } } }));

const profilesDoc = {
  schema: "factory.workers.v1",
  workspaceRoot: ws,
  workers: {
    "claude-a": { provider: "claude", bin: join(binDir, "claude-a"), model: "sonnet", effort: "high", modes: ["implement", "review"], pluginDirs: [join(scratch, "plugins", "matt")], timeout: "60s" },
    "claude-b": { provider: "claude", bin: join(binDir, "claude-b"), configDir: join(scratch, "profiles", "claude-b"), model: "opus", effort: "low", modes: ["review", "implement"], mcp: { config: join(conf, "mcp-claude.json"), allowTools: ["mcp__mock__echo"] }, timeout: "60s" },
    codex: { provider: "codex", bin: join(binDir, "codex"), codexHome: join(scratch, "profiles", "codex-home"), model: "gpt-fake", effort: "medium", modes: ["implement", "review"], mcp: { config: join(conf, "mcp-codex.json") }, timeout: "60s" },
    "review-only": { provider: "claude", bin: join(binDir, "claude-a"), modes: ["review"], timeout: "60s" },
    "codex-hanger": { provider: "codex", bin: join(binDir, "codex"), codexHome: join(scratch, "profiles", "codex-home"), model: "gpt-fake", modes: ["implement"], timeout: "3s" },
    hanger: { provider: "claude", bin: join(binDir, "claude-a"), modes: ["implement"], pluginDirs: [join(scratch, "plugins", "matt")], timeout: "3s" },
    "codex-skilled": { provider: "codex", bin: join(binDir, "codex"), codexHome: join(scratch, "profiles", "codex-home"), skillsHome: join(scratch, "plugins", "matt"), model: "gpt-fake", modes: ["implement"], timeout: "60s" },
    oc: { provider: "opencode", bin: join(binDir, "opencode"), model: "opencode-go/glm-5.3", effort: "default", modes: ["implement", "review"], denyRead: [join(scratch, "private"), join(scratch, "out")], timeout: "60s" },
    "claude-denyread": { provider: "claude", bin: join(binDir, "claude-a"), modes: ["implement", "review"], denyRead: [join(scratch, "private")], timeout: "60s" },
  },
};
const profilesPath = join(conf, "workers.json");
writeFileSync(profilesPath, JSON.stringify(profilesDoc, null, 2), { mode: 0o600 });

function freshRepo(name) {
  const remote = join(scratch, `${name}-remote.git`);
  const repo = join(ws, name);
  g(scratch, "init", "-q", "--bare", "-b", "main", remote);
  g(scratch, "clone", "-q", remote, repo);
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "feature.js"), "export const value = 0;\n");
  writeFileSync(join(repo, ".gitignore"), ".factory-out/\n");
  g(repo, "add", "-A");
  g(repo, "commit", "-q", "-m", "init");
  g(repo, "push", "-q", "origin", "HEAD:main");
  return { repo, remote };
}

let briefN = 0;
const brief = (text = "factory contract brief") => {
  const path = join(scratch, `brief-${++briefN}.md`);
  writeFileSync(path, text);
  return path;
};
const logOf = (file) => (existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const SECRET = "sk-ant-SENTINEL-do-not-leak-7731";
const parentEnv = (extra = {}) => ({
  ...process.env,
  ANTHROPIC_API_KEY: SECRET, CLAUDE_CODE_OAUTH_TOKEN: SECRET, OPENAI_API_KEY: SECRET, CODEX_API_KEY: SECRET,
  ANTHROPIC_BASE_URL: "https://evil.invalid", CLAUDE_CONFIG_DIR: "/some/other/profile", CODEX_HOME: "/some/other/codex",
  ...extra,
});
async function run(workerId, mode, repo, envExtra = {}, opts = {}) {
  const outDir = join(scratch, "out", `${workerId}-${mode}-${++briefN}`);
  const log = join(scratch, `log-${briefN}.jsonl`);
  const result = await dispatch({ profilesPath, workerId, mode, cd: repo, brief: brief(opts.brief), outDir, session: opts.session ?? null, env: parentEnv({ FAKE_LOG: log, ...envExtra }) });
  return { ...result, outDir, launches: logOf(log) };
}

const groups = {
  async selection() {
    const { repo } = freshRepo("sel");
    const a = await run("claude-a", "implement", repo, { FAKE_MODE: "implement-commit" });
    const b = await run("claude-b", "review", repo);
    const c = await run("codex", "review", repo);
    check("1 claude-a profile launched its own executable", a.launches[0]?.bin === join(binDir, "claude-a"), a.launches[0]?.bin);
    check("1 claude-b profile launched its own executable", b.launches[0]?.bin === join(binDir, "claude-b"));
    check("1 codex profile launched codex exec", c.launches[0]?.bin === join(binDir, "codex") && c.launches[0].args[0] === "exec");
    check("1 relay records the worker id", a.result?.worker === "claude-a" && b.result?.worker === "claude-b" && c.result?.worker === "codex");
    check("2 claude model and effort propagated", pair(a.launches[0].args, "--model", "sonnet") && pair(a.launches[0].args, "--effort", "high"));
    check("2 claude-b model and effort propagated", pair(b.launches[0].args, "--model", "opus") && pair(b.launches[0].args, "--effort", "low"));
    check("2 codex model and effort propagated", pair(c.launches[0].args, "-m", "gpt-fake") && c.launches[0].args.includes("model_reasoning_effort=medium"));
    check("2 working directory is the ticket workspace", [a, b, c].every((r) => r.launches[0].cwd === repo));
    check("2 claude-a keeps the default profile (CLAUDE_CONFIG_DIR unset)", a.launches[0].env.CLAUDE_CONFIG_DIR === null);
    check("2 claude-b gets its own CLAUDE_CONFIG_DIR", b.launches[0].env.CLAUDE_CONFIG_DIR === join(scratch, "profiles", "claude-b"));
    check("2 codex gets its own CODEX_HOME", c.launches[0].env.CODEX_HOME === join(scratch, "profiles", "codex-home"));
    check("3 no paid-API or foreign-profile variable reaches any worker", [a, b, c].every((r) => r.launches[0].env.secretsSeen.length === 0), JSON.stringify([a, b, c].map((r) => r.launches[0].env.secretsSeen)));
    check("3 inherited CLAUDECODE is removed", a.launches[0].env.CLAUDECODE === null);
    const artifacts = [a, b, c].flatMap((r) => readdirSync(r.outDir).map((f) => readFileSync(join(r.outDir, f), "utf8"))).join("\n");
    check("3 sentinel secret appears in no relay artifact", !artifacts.includes(SECRET));
  },

  async skills() {
    const { repo } = freshRepo("skills");
    const a = await run("claude-a", "implement", repo, { FAKE_MODE: "implement-commit" });
    const b = await run("claude-b", "implement", repo, { FAKE_MODE: "implement-commit" });
    const r = await run("claude-a", "review", repo);
    const args = a.launches[0].args;
    check("4 implement mode does not disable slash commands", !args.includes("--disable-slash-commands"));
    check("4 implement mode exposes the Skill and Agent tools", pair(args, "--tools", "Read,Glob,Grep,Edit,Write,Bash,Skill,Agent"));
    check("4 implement mode loads only project/local settings", pair(args, "--setting-sources", "project,local"));
    check("4 implement mode passes the pinned plugin dir", pair(args, "--plugin-dir", join(scratch, "plugins", "matt")));
    check("4 review mode keeps upstream restrictions", r.launches[0].args.includes("--disable-slash-commands") && pair(r.launches[0].args, "--tools", "Read,Glob,Grep") && pair(r.launches[0].args, "--permission-mode", "plan"));
    check("4 Skill tool calls are recorded", JSON.stringify(a.result?.skillCalls) === '["tdd"]');
    check("4 native skill trace read from the profile transcript", b.result?.skillTrace?.commands?.[0] === "/mattpocock-skills:implement", JSON.stringify(b.result?.skillTrace));
    const c = await run("codex", "implement", repo, { FAKE_MODE: "implement-commit" });
    check("4 codex skill trace read from the rollout", c.result?.skillTrace?.skills?.[0]?.name === "implement", JSON.stringify(c.result?.skillTrace));
  },

  async mcp() {
    const { repo } = freshRepo("mcp");
    const none = await run("claude-a", "implement", repo, { FAKE_MODE: "implement-commit" });
    const withMcp = await run("claude-b", "implement", repo, { FAKE_MODE: "mcp-denied" });
    const codex = await run("codex", "implement", repo, { FAKE_MODE: "implement-commit" });
    check("5 no MCP config → every MCP tool denied", pair(none.launches[0].args, "--disallowedTools", "mcp__*") && !none.launches[0].args.includes("--mcp-config"));
    const args = withMcp.launches[0].args;
    check("5 MCP allowlist → strict config with only the profile's server file", args.includes("--strict-mcp-config") && pair(args, "--mcp-config", join(conf, "mcp-claude.json")));
    check("5 MCP allowlist → only listed tools pre-approved", pair(args, "--allowedTools", "mcp__mock__echo") && args.filter((a) => a.startsWith("mcp__")).length === 1);
    check("5 denied MCP tool surfaces in result.permissionDenials", JSON.stringify(withMcp.result?.permissionDenials) === '["mcp__mock__secret"]');
    const cargs = codex.launches[0].args;
    check("5 codex MCP server exposed with enabled_tools allowlist", cargs.includes('mcp_servers.mock.enabled_tools=["echo"]') && cargs.includes('mcp_servers.mock.tools.echo.approval_mode="approve"') && !cargs.some((a) => a.includes("tools.secret")) && cargs.includes("--ignore-user-config"));
    const badTool = spawnSync(process.execPath, [join(ROOT, "skills/claude-delegate/scripts/relay.mjs"), "--brief", brief(), "--cd", repo, "--implement", "--mcp-config", join(conf, "mcp-claude.json"), "--allow-mcp-tool", "mcp__*"], { encoding: "utf8" });
    check("5 wildcard MCP allow rejected", badTool.status === 2 && /must name one tool/.test(badTool.stderr));
    writeFileSync(join(conf, "mcp-codex-bad.json"), JSON.stringify({ servers: { mock: { command: "node", enabledTools: ["echo"] } } }));
    const badCodex = spawnSync(process.execPath, [join(ROOT, "skills/codex-delegate/scripts/relay.mjs"), "--brief", brief(), "--cd", repo, "--mcp-config", join(conf, "mcp-codex-bad.json")], { encoding: "utf8" });
    check("5 codex MCP server with relative command rejected", badCodex.status === 2 && /absolute "command"/.test(badCodex.stderr));
  },

  async readonly() {
    const { repo } = freshRepo("ro");
    const r = await run("claude-a", "review", repo, { FAKE_MODE: "review-write" });
    check("6 read-only review write is reported (tripwire, not OS isolation)", r.result?.readOnlyViolation === true);
    const c = await run("codex", "review", repo);
    check("6 codex review runs in the read-only sandbox", pair(c.launches[0].args, "-s", "read-only") && !c.launches[0].args.includes("--add-dir"));
    let refused = null;
    try { resolveWorker(loadProfiles(profilesPath), "review-only", "implement", repo); } catch (error) { refused = error.message; }
    check("6 review-only profile cannot be dispatched to implement", /not allowed to implement/.test(refused ?? ""));
  },

  async git() {
    const { repo } = freshRepo("git");
    g(repo, "switch", "-q", "-c", "factory/T-1");
    const settings = (await run("claude-a", "implement", repo, { FAKE_MODE: "implement-nocommit" })).result;
    const profile = JSON.parse(readFileSync(settings.settingsPath, "utf8"));
    const deny = profile.permissions.deny.join(" ");
    check("7 implement profile denies commit, push, gh and nested claude", deny.includes("git commit") && deny.includes("git push") && deny.includes("gh *") && deny.includes("claude *"));
    const gitDir = join(realpathSync(repo), ".git");
    check("7 implement mode write-protects .git and .claude for Edit/Write", deny.includes(`Edit(/${gitDir}/**)`) && deny.includes(`Write(/${gitDir}/**)`) && deny.includes(`Edit(/${join(realpathSync(repo), ".claude")}/**)`), deny);
    check("7 implement mode write-protects .git in the shell sandbox", JSON.stringify(profile.sandbox?.filesystem?.denyWrite ?? []).includes(gitDir), JSON.stringify(profile.sandbox?.filesystem));
    check("7 result records the protected paths", settings.protectedPaths?.includes(gitDir));
    const review = (await run("claude-a", "review", repo)).result;
    check("7 sandbox stays strict in implement mode", settings.shellSandbox === "strict" && profile.sandbox?.allowUnsandboxedCommands === false);
    check("7 review runs keep plan mode", review.permissionMode === "plan");
    g(repo, "checkout", "-q", "--", ".");
    const cases = [
      ["implement-commit", true, null],
      ["tamper-main", false, /refs\/heads\/main moved/],
      ["tamper-new-branch", false, /refs\/heads\/sneaky created/],
      ["tamper-hook", false, /git hooks changed/],
      ["tamper-config", false, /git config changed/],
      ["rewrite-history", false, /rewritten/],
      ["switch-branch", false, /HEAD moved/],
    ];
    for (const [mode, expectOk, pattern] of cases) {
      const { repo: r } = freshRepo(`guard-${mode}`);
      g(r, "switch", "-q", "-c", "factory/T-1");
      g(r, "commit", "-q", "--allow-empty", "-m", "base on branch");
      const before = snapshot(r);
      await run("claude-a", "implement", r, { FAKE_MODE: mode });
      const verdict = verify(r, before, { branch: "factory/T-1" });
      check(`7 git guard ${expectOk ? "accepts" : "rejects"} ${mode}`, verdict.ok === expectOk && (pattern === null || verdict.violations.some((v) => pattern.test(v))), JSON.stringify(verdict.violations));
    }
    const { repo: cr } = freshRepo("codex-git");
    const c = await run("codex", "implement", cr, { FAKE_MODE: "implement-commit" });
    check("7 codex implement: workspace-write, offline, no writable git root", !c.launches[0].args.includes("--add-dir") && pair(c.launches[0].args, "-s", "workspace-write") && !c.launches[0].args.some((a) => a.includes("network_access")) && c.result?.gitWritableRoot === null);
    check("7 no relay ever pushes (remote main unchanged)", g(cr, "ls-remote", "origin", "refs/heads/factory/T-1") === "");
  },

  async negative() {
    const { repo } = freshRepo("neg");
    const expectThrow = (label, fn, pattern) => {
      let message = null;
      try { fn(); } catch (error) { message = error.message; }
      check(`8 ${label}`, message !== null && pattern.test(message), message ?? "did not throw");
    };
    const writeProfiles = (mutate, file = join(conf, "variant.json"), mode = 0o600) => {
      const doc = structuredClone(profilesDoc);
      mutate(doc);
      writeFileSync(file, JSON.stringify(doc), { mode });
      chmodSync(file, mode);
      return file;
    };
    expectThrow("relative bin rejected", () => loadProfiles(writeProfiles((d) => { d.workers["claude-a"].bin = "claude"; })), /absolute path/);
    expectThrow("missing bin rejected", () => loadProfiles(writeProfiles((d) => { d.workers["claude-a"].bin = "/nope/claude"; })), /missing or not executable/);
    expectThrow("unknown worker field rejected", () => loadProfiles(writeProfiles((d) => { d.workers["claude-a"].command = "rm -rf /"; })), /unknown field/);
    expectThrow("cross-provider profile dir rejected", () => loadProfiles(writeProfiles((d) => { d.workers.codex.configDir = conf; })), /does not apply/);
    expectThrow("group-writable profiles file refused", () => loadProfiles(writeProfiles(() => {}, join(conf, "loose.json"), 0o666)), /world-writable/);
    expectThrow("profiles file inside the workspace refused", () => loadProfiles(writeProfiles(() => {}, join(ws, "workers.json"))), /outside workspaceRoot/);
    expectThrow("unknown worker refused", () => resolveWorker(loadProfiles(profilesPath), "ghost", "review", repo), /unknown worker/);
    expectThrow("workspace outside root refused", () => resolveWorker(loadProfiles(profilesPath), "claude-a", "review", scratch), /outside workspaceRoot/);
    expectThrow("skillsHome on a claude worker refused", () => loadProfiles(writeProfiles((d) => { d.workers["claude-a"].skillsHome = conf; })), /does not apply to claude/);
    expectThrow("relative denyRead refused", () => loadProfiles(writeProfiles((d) => { d.workers["claude-a"].denyRead = ["secrets"]; })), /absolute paths/);
    expectThrow("injected worker id refused", () => loadProfiles(writeProfiles((d) => { d.workers["a;rm -rf"] = d.workers["claude-a"]; })), /unsupported characters/);
    const relay = (provider, extra) => spawnSync(process.execPath, [join(ROOT, `skills/${provider}-delegate/scripts/relay.mjs`), "--brief", brief(), "--cd", repo, ...extra], { encoding: "utf8" });
    const cases = [
      ["claude", ["--model", "sonnet; rm -rf ~"], /unsupported characters/],
      ["claude", ["--claude-bin", "claude"], /absolute path/],
      ["claude", ["--claude-bin", "/nope/claude"], /missing or not executable/],
      ["claude", ["--config-dir", "relative/dir"], /absolute path/],
      ["claude", ["--implement", "--read-only"], /cannot be combined/],
      ["claude", ["--implement", "--dangerously-skip-permissions"], /cannot be combined/],
      ["claude", ["--plugin-dir", conf], /requires --implement/],
      ["claude", ["--worker", "$(id)"], /unsupported characters/],
      ["codex", ["--codex-bin", "codex"], /absolute path/],
      ["codex", ["--implement", "--read-only"], /workspace-write/],
      ["codex", ["--implement", "--network-access"], /offline/],
      ["codex", ["--codex-home", "/nope/home"], /not found/],
      ["codex", ["--home", "relative/home"], /existing absolute directory/],
      ["codex", ["--codex-config", "no equals sign"], /key=value/],
      ["claude", ["--deny-read", "relative/secret"], /absolute path/],
    ];
    for (const [provider, extra, pattern] of cases) {
      const r = relay(provider, extra);
      check(`8 ${provider} relay rejects ${extra.join(" ")}`, r.status === 2 && pattern.test(r.stderr), r.stderr.trim());
    }
    const outside = mkdtempSync(join(tmpdir(), "factory-nogit-"));
    const r = relay("codex", ["--implement", "--cd", outside]);
    check("8 codex implement outside a git repo refused", r.status === 2 && /git repository/.test(r.stderr));
    const laneFile = join(conf, "fleet-bad.json");
    writeFileSync(laneFile, JSON.stringify({ version: "delegate-fleet.v1", lanes: { x: { implementer: "claude", configDir: "relative" } } }));
    const lane = spawnSync(process.execPath, [join(ROOT, "skills/delegate-setup/scripts/config.mjs"), "validate", laneFile], { encoding: "utf8" });
    check("8 lane dial with relative profile path rejected", lane.status !== 0 && /absolute path/.test(lane.stdout + lane.stderr), lane.stdout + lane.stderr);
    writeFileSync(laneFile, JSON.stringify({ version: "delegate-fleet.v1", lanes: { "review-main": { implementer: "claude", worker: "claude-b", configDir: join(scratch, "profiles", "claude-b"), claudeBin: join(binDir, "claude-b"), model: "opus" } } }));
    const goodLane = spawnSync(process.execPath, [join(ROOT, "skills/delegate-setup/scripts/config.mjs"), "validate", laneFile], { encoding: "utf8" });
    check("8 lane carrying a worker profile validates", goodLane.status === 0, goodLane.stdout + goodLane.stderr);
  },

  async lifecycle() {
    const { repo } = freshRepo("life");
    const pidFile = join(scratch, "grandchild.pid");
    const hang = await run("hanger", "implement", repo, { FAKE_MODE: "hang", FAKE_PID_FILE: pidFile });
    const pid = Number(readFileSync(pidFile, "utf8"));
    const alive = (() => { try { process.kill(pid, 0); return true; } catch { return false; } })();
    check("9 profile timeout kills the run and reports timeout", hang.result?.status === "timeout" && hang.exitCode !== 0);
    check("9 timeout fells the grandchild process", !alive);
    const detachedPid = join(scratch, "detached.pid");
    const cxHang = await run("codex-hanger", "implement", repo, { FAKE_MODE: "hang", FAKE_PID_FILE: detachedPid, FAKE_DETACH: "1" });
    await new Promise((r) => setTimeout(r, 500));
    const detachedAlive = (() => { try { process.kill(Number(readFileSync(detachedPid, "utf8")), 0); return true; } catch { return false; } })();
    check("9 codex timeout also fells a command in its own process group", cxHang.result?.status === "timeout" && !detachedAlive);
    const outDir = join(scratch, "out", "cancel");
    const profiles = loadProfiles(profilesPath);
    const argv = relayArgv(profiles.workers["claude-a"], { mode: "implement", workspace: repo, brief: brief(), outDir });
    const child = spawn(process.execPath, argv, { env: workerEnv(parentEnv({ FAKE_MODE: "hang", FAKE_PID_FILE: pidFile })), stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 1500));
    child.kill("SIGTERM");
    await new Promise((r) => child.on("close", r));
    const cancelled = JSON.parse(readFileSync(join(outDir, "result.json"), "utf8"));
    check("9 cancellation writes an aborted result", cancelled.status === "aborted" && cancelled.signal === "SIGTERM");
    const crash = await run("claude-a", "implement", repo, { FAKE_MODE: "no-result" });
    check("9 crash without a terminal event is classified failed", crash.result?.status === "failed" && /without a terminal result event/.test(crash.result?.error ?? ""));
    const ok = await run("claude-a", "implement", repo, { FAKE_MODE: "implement-nocommit" });
    check("10 claude session id captured", ok.result?.sessionId === "aaaaaaaa-1111-4111-8111-000000000001");
    const resumed = await run("claude-a", "implement", repo, { FAKE_MODE: "implement-nocommit" }, { session: ok.result.sessionId });
    check("10 claude resume passes --resume with the same profile flags", pair(resumed.launches[0].args, "--resume", ok.result.sessionId) && pair(resumed.launches[0].args, "--setting-sources", "project,local") && resumed.result?.resumed === true);
    const cx = await run("codex", "implement", repo, { FAKE_MODE: "implement-nocommit" });
    const cxr = await run("codex", "implement", repo, { FAKE_MODE: "implement-nocommit" }, { session: cx.result.threadId });
    check("10 codex thread id captured and resumed", cx.result?.threadId === "0199aaaa-2222-7222-8222-000000000002" && cxr.launches[0].args.includes("resume") && cxr.launches[0].args.includes(cx.result.threadId));
    const ra = cxr.launches[0].args;
    check("10 codex implement resume restates the sandbox before `resume` and adds no writable root", !ra.includes("--add-dir") && pair(ra, "-s", "workspace-write") && ra.indexOf("-s") < ra.indexOf("resume"), JSON.stringify(ra));
    check("10 passive capacity telemetry captured from claude run", fromRelayResult(ok.result)?.windows?.five_hour?.usedPercent === 31);
    check("10 passive capacity telemetry captured from codex rollout", fromRelayResult(cx.result)?.windows?.seven_day?.usedPercent === 12);
  },

  async contract() {
    const { repo } = freshRepo("contract");
    const upstream = process.env.UPSTREAM_DELEGATE_SKILLS;
    for (const provider of ["claude", "codex"]) {
      const base = (relayRoot, out) => spawnSync(process.execPath, [join(relayRoot, `skills/${provider}-delegate/scripts/relay.mjs`), "--brief", brief(), "--cd", repo, "--out-dir", out], {
        env: { ...process.env, PATH: `${join(scratch, "pathbin")}:${process.env.PATH}`, FAKE_PROVIDER: provider }, encoding: "utf8",
      });
      mkdirSync(join(scratch, "pathbin"), { recursive: true });
      copyFileSync(join(here, "fixtures", "fake-agent.cjs"), join(scratch, "pathbin", provider));
      chmodSync(join(scratch, "pathbin", provider), 0o755);
      const forkOut = join(scratch, "out", `contract-fork-${provider}`);
      const fork = base(ROOT, forkOut);
      const forkResult = JSON.parse(readFileSync(join(forkOut, "result.json"), "utf8"));
      check(`11 ${provider} default run still completes with schema v1`, fork.status === 0 && forkResult.schema === "delegate-relay.result.v1" && forkResult.status === "completed");
      check(`11 ${provider} default run adds no Factory fields`, !["worker", "mode", "skillTrace", "claudeBin", "codexBin", "configDir", "codexHome"].some((k) => k in forkResult));
      if (upstream) {
        const upOut = join(scratch, "out", `contract-up-${provider}`);
        base(upstream, upOut);
        const upResult = JSON.parse(readFileSync(join(upOut, "result.json"), "utf8"));
        const strip = (r) => Object.keys(r).filter((k) => !["rateLimit"].includes(k)).sort().join(",");
        check(`11 ${provider} default result keys identical to upstream ${upResult.schema}`, strip(forkResult) === strip(upResult), `fork=${strip(forkResult)}\nupstream=${strip(upResult)}`);
        const argsOf = (out) => JSON.parse(readFileSync(join(out, provider === "claude" ? "profile.json" : "brief.txt"), "utf8").startsWith("{") ? readFileSync(join(out, "profile.json"), "utf8") : "{}");
        if (provider === "claude") check("11 claude default profile.json byte-identical to upstream", readFileSync(join(forkOut, "profile.json"), "utf8") === readFileSync(join(upOut, "profile.json"), "utf8"));
        void argsOf;
      }
    }
  },

  async capacity() {
    const now = Date.parse("2026-10-23T10:00:00Z");
    const fresh = { measured: true, observedAt: "2026-10-23T09:59:00Z", windows: { five_hour: { usedPercent: 40 }, seven_day: { usedPercent: 10 } } };
    check("Q fresh measured headroom allows dispatch", gate(fresh, { now }).dispatch === true);
    check("Q stale telemetry → CAPACITY_SYNC_REQUIRED", gate({ ...fresh, observedAt: "2026-10-23T08:00:00Z" }, { now }).state === "CAPACITY_SYNC_REQUIRED");
    check("Q low headroom → CAPACITY_LOW", gate({ ...fresh, windows: { five_hour: { usedPercent: 92 }, seven_day: { usedPercent: 10 } } }, { now }).state === "CAPACITY_LOW");
    check("Q provider rate limit → RATE_LIMITED", gate({ ...fresh, limitReached: "rate_limited" }, { now }).state === "RATE_LIMITED");
    check("Q estimate never authorizes dispatch", gate({ ...fresh, measured: false }, { now }).dispatch === false);
    check("Q missing window → CAPACITY_SYNC_REQUIRED", gate({ ...fresh, windows: { five_hour: null } }, { now }).state === "CAPACITY_SYNC_REQUIRED");
    check("Q no telemetry → CAPACITY_SYNC_REQUIRED", gate(null, { now }).state === "CAPACITY_SYNC_REQUIRED");
    const parsed = parseClaudeUsage("Current session: 23% used · resets Oct 23 at 12:39pm (Africa/Cairo)\nCurrent week (all models): 3% used · resets Oct 30 at 6:59am (Africa/Cairo)\n");
    check("Q /usage text parsed into both windows", parsed.five_hour.usedPercent === 23 && parsed.seven_day.usedPercent === 3 && /Oct 30/.test(parsed.seven_day.resetsText));
    check("Q unrecognised /usage text is reported unparsed, not guessed", parseClaudeUsage("Total cost: $0").five_hour === null);
    const cw = codexWindows({ primary: { usedPercent: 8, windowDurationMins: 10080, resetsAt: 1793303027 }, secondary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1793300000 } });
    check("Q codex windows mapped by duration", cw.windows.seven_day.usedPercent === 8 && cw.windows.five_hour.usedPercent === 50);
  },

  async e2e() {
    const { repo, remote } = freshRepo("e2e");
    const ghState = join(scratch, "gh-state.json");
    const counterFile = join(scratch, "fake-counter");
    const stateDir = join(scratch, "state");
    const forge = { gh: join(binDir, "gh"), repo: "sandbox/fake", env: { FAKE_GH_STATE: ghState, FAKE_GH_REMOTE: remote } };
    const ticket = (id, extra = {}) => {
      const t = {
        id, title: `ticket ${id}`, issue: `.scratch/issues/${id}.md`, repo, remote: "origin", base: "main",
        approval: { approved: true, by: "founder", at: "2026-10-23" }, profiles: profilesPath, implementer: "claude-a",
        review: { mode: "single", worker: "codex" }, mattSkillsDir: process.env.MATT_SKILLS_DIR ?? join(ROOT, "test", "factory", "fixtures"),
        seams: ["src/feature.js value export"], testCommand: ["node", "-e", "process.exit(require('fs').readFileSync('src/feature.js','utf8').includes('42')?0:1)"],
        maxRemediationRounds: 1, forge, ...extra,
      };
      const file = join(scratch, `${id}.ticket.json`);
      writeFileSync(file, JSON.stringify(t));
      return file;
    };
    mkdirSync(join(ROOT, "test", "factory", "fixtures", "skills", "engineering", "code-review"), { recursive: true });
    writeFileSync(join(ROOT, "test", "factory", "fixtures", "skills", "engineering", "code-review", "SKILL.md"), "fixture code-review skill\n");
    const env = (mode, extra = {}) => Object.assign(process.env, { FAKE_MODE: mode, FAKE_COUNTER: counterFile, ...extra });
    const gh = () => JSON.parse(readFileSync(ghState, "utf8"));

    env("implement-commit");
    const unapproved = ticket("T-0", { approval: null });
    check("E no ticket starts without explicit approval", (await runTicket(unapproved, stateDir)) === false && JSON.parse(readFileSync(join(stateDir, "T-0.json"), "utf8")).phase === "AWAITING_APPROVAL");

    const gateLog = join(scratch, "e2e-gate.jsonl");
    env("implement-edit", { FAKE_LOG: gateLog });
    const gated = ticket("T-G", { capacityGate: true });
    const gatedOk = await runTicket(gated, stateDir);
    const sg = JSON.parse(readFileSync(join(stateDir, "T-G.json"), "utf8"));
    check("Q harness capacity gate fails closed on unreadable telemetry and dispatches nothing", gatedOk === false && sg.phase === "CAPACITY_SYNC_REQUIRED" && sg.capacityResume === "IMPLEMENTING" && logOf(gateLog).every((l) => !l.args.includes("--plugin-dir")), JSON.stringify(sg));
    g(repo, "switch", "-q", "main");

    const log = join(scratch, "e2e-agent.jsonl");
    env("buggy-then-fix", { FAKE_LOG: log });
    process.env.FAKE_MODE = "buggy-then-fix";
    const t1 = ticket("T-1");
    process.env.FACTORY_CRASH_AT = "after-implement-before-checkpoint";
    const crashed = spawnSync(process.execPath, [join(ROOT, "factory/harness.mjs"), "--ticket", t1, "--state-dir", stateDir], { encoding: "utf8", env: process.env });
    delete process.env.FACTORY_CRASH_AT;
    check("E simulated crash after implementation exits non-zero", crashed.status === 137, crashed.stderr);
    process.env.FACTORY_CRASH_AT = "after-pr-before-checkpoint";
    const crashed2 = spawnSync(process.execPath, [join(ROOT, "factory/harness.mjs"), "--ticket", t1, "--state-dir", stateDir], { encoding: "utf8", env: process.env });
    delete process.env.FACTORY_CRASH_AT;
    check("E simulated crash after PR creation exits non-zero", crashed2.status === 137, crashed2.stderr + crashed2.stdout);
    const done = await runTicket(t1, stateDir);
    const s1 = JSON.parse(readFileSync(join(stateDir, "T-1.json"), "utf8"));
    const launches = logOf(log).filter((l) => l.args.includes("--setting-sources"));
    check("E crash after implement adopted the finished run (no duplicate dispatch)", s1.runs[0].adopted === true);
    check("E failing tests sent the ticket to remediation, not to PR", s1.runs.map((r) => r.kind).join(",") === "implement,remediate", s1.runs.map((r) => r.kind).join(","));
    check("E remediation resumed the implementer session", launches.length === 2 && pair(launches[1].args, "--resume", "aaaaaaaa-1111-4111-8111-000000000001"));
    check("E exactly one PR for the ticket branch despite the crash", gh().prs.filter((p) => p.headRefName === "factory/T-1").length === 1);
    check("E PR reached ready only after tests passed", done === true && s1.phase === "AWAITING_OWNER_MERGE" && s1.tests.passed === true && gh().prs[0].isDraft === false);
    check("E PR head equals the tested and reviewed head", gh().prs[0] && s1.reviews[s1.headSha]?.verdict === "pass" && g(repo, "ls-remote", "origin", "refs/heads/factory/T-1").startsWith(s1.headSha));
    check("E one commit per implementation round (no duplicates)", Number(g(repo, "rev-list", "--count", `${s1.baseSha}..factory/T-1`)) === 2);
    check("E nothing ever asked gh to merge", !gh().calls.some((c) => c.includes("merge")));
    const again = await runTicket(t1, stateDir);
    check("E re-running a finished ticket is a no-op", again === true && gh().prs.length === 1 && JSON.parse(readFileSync(join(stateDir, "T-1.json"), "utf8")).runs.length === 2);

    check("E PR commits were made by the broker, never by the implementer", g(repo, "log", "--format=%cn", `${s1.baseSha}..factory/T-1`).split("\n").every((n) => n === "factory-broker"));
    check("E failed test run kept in history with its evidence", s1.testRuns[0].passed === false && s1.testRuns.at(-1).passed === true && s1.testRuns[0].runner === "docker");
    g(repo, "switch", "-q", "main");
    process.env.FAKE_MODE = "implement-edit";
    const before = logOf(log).length;
    const t2 = ticket("T-2", { dependsOn: ["T-1"] });
    const t2Unapproved = ticket("T-2", { dependsOn: ["T-1"], approval: null });
    check("E dependent ticket needs its own approval", (await runTicket(t2Unapproved, stateDir)) === false && JSON.parse(readFileSync(join(stateDir, "T-2.json"), "utf8")).phase === "AWAITING_APPROVAL");
    writeFileSync(join(scratch, "T-2.ticket.json"), readFileSync(t2Unapproved, "utf8").replace('"approval":null', `"approval":${JSON.stringify({ approved: true, by: "founder", at: "2026-10-23" })}`));
    check("E dependent ticket blocked while prerequisite PR is open (ready, not merged)", (await runTicket(t2, stateDir)) === false && JSON.parse(readFileSync(join(stateDir, "T-2.json"), "utf8")).phase === "BLOCKED_DEPENDENCY");
    const state = gh();
    state.prs[0].state = "MERGED";
    state.prs[0].mergeCommit = { oid: g(repo, "rev-parse", "factory/T-1") };
    writeFileSync(ghState, JSON.stringify(state));
    const notOnBase = await runTicket(t2, stateDir);
    check("E MERGED state alone is not enough: the merge commit must be on the remote base", notOnBase === false && /merge commit not on origin\/main/.test(JSON.parse(readFileSync(join(stateDir, "T-2.json"), "utf8")).reason));
    check("E no implementation started while the dependency or approval was missing", logOf(log).length === before);
    g(repo, "push", "-q", "origin", "factory/T-1:main");
    process.env.FAKE_REVIEW = "review-block";
    process.env.FAKE_GH_STALE_VIEWS = "2";
    writeFileSync(join(scratch, "T-2.ticket.json"), JSON.stringify({ ...JSON.parse(readFileSync(t2, "utf8")), prHeadPollMs: 100 }));
    const blocked = await runTicket(t2, stateDir);
    delete process.env.FAKE_GH_STALE_VIEWS;
    const s2 = JSON.parse(readFileSync(join(stateDir, "T-2.json"), "utf8"));
    check("E dependency satisfied only after the prerequisite merged", s2.runs.length >= 1);
    check("E blocking review keeps the PR draft and exhausts bounded remediation", blocked === false && s2.phase === "BLOCKED" && gh().prs.find((p) => p.headRefName === "factory/T-2")?.isDraft === true, `${s2.phase} ${s2.reason}`);
    check("E remediation push waited out a lagging PR head instead of failing", !/is not the tested head/.test(s2.reason ?? "") && gh().staleViews === 0, `${s2.reason} stale=${gh().staleViews}`);
    check("E one review per head SHA", Object.keys(s2.reviews).length === new Set(Object.keys(s2.reviews)).size && Object.keys(s2.reviews).length === s2.runs.length);
    delete process.env.FAKE_REVIEW;

    g(repo, "switch", "-q", "main");
    const pidFile = join(scratch, "e2e-hang.pid");
    const hangLog = join(scratch, "e2e-hang.jsonl");
    Object.assign(process.env, { FAKE_MODE: "init-then-hang", FAKE_PID_FILE: pidFile, FAKE_LOG: hangLog });
    const t3 = ticket("T-3", { implementer: "hanger", maxInterruptions: 1 });
    const interrupted = await runTicket(t3, stateDir);
    const s3a = JSON.parse(readFileSync(join(stateDir, "T-3.json"), "utf8"));
    const grandchildAlive = (() => { try { process.kill(Number(readFileSync(pidFile, "utf8")), 0); return true; } catch { return false; } })();
    check("D timeout is recorded as an interruption with its session", interrupted === false && s3a.phase === "INTERRUPTED" && s3a.runs[0].status === "timeout" && s3a.interruption.sessionId === "aaaaaaaa-1111-4111-8111-000000000001", JSON.stringify(s3a.runs));
    check("D timeout cleaned up the process tree", !grandchildAlive);
    check("D reconciliation kept the partial edits and made no commit", s3a.interruption.dirty.some((l) => l.includes("src/")) && g(repo, "rev-list", "--count", `${s3a.baseSha}..factory/T-3`) === "0");
    process.env.FAKE_MODE = "implement-edit";
    process.env.FACTORY_CRASH_AT = "after-commit-before-checkpoint";
    const crashed3 = spawnSync(process.execPath, [join(ROOT, "factory/harness.mjs"), "--ticket", t3, "--state-dir", stateDir], { encoding: "utf8", env: process.env });
    check("D simulated crash right after the broker commit", crashed3.status === 137, crashed3.stderr);
    process.env.FACTORY_CRASH_AT = "during-tests";
    const crashed4 = spawnSync(process.execPath, [join(ROOT, "factory/harness.mjs"), "--ticket", t3, "--state-dir", stateDir], { encoding: "utf8", env: process.env });
    delete process.env.FACTORY_CRASH_AT;
    check("D simulated crash while the test container runs", crashed4.status === 137, crashed4.stderr);
    const finished = await runTicket(t3, stateDir);
    const s3 = JSON.parse(readFileSync(join(stateDir, "T-3.json"), "utf8"));
    const resumes = logOf(hangLog).filter((l) => l.args.includes("--resume"));
    check("D the interrupted session was resumed with the same profile flags and workspace", resumes.length === 1 && pair(resumes[0].args, "--resume", "aaaaaaaa-1111-4111-8111-000000000001") && pair(resumes[0].args, "--setting-sources", "project,local") && resumes[0].cwd === repo);
    check("D broker commit adopted after the crash (exactly one commit)", s3.runs.find((r) => r.kind === "implement-resume")?.broker?.adopted === true && g(repo, "rev-list", "--count", `${s3.baseSha}..factory/T-3`) === "1", JSON.stringify(s3.runs));
    check("D leftover test container removed before the rerun", s3.testRuns.at(-1).leftoversRemoved >= 1 && s3.testRuns.at(-1).containersAfter === 0, JSON.stringify(s3.testRuns.at(-1)));
    check("D ticket finished with one PR", finished === true && gh().prs.filter((p) => p.headRefName === "factory/T-3").length === 1);
    for (const key of ["FAKE_MODE", "FAKE_COUNTER", "FAKE_LOG", "FAKE_REVIEW", "FAKE_PID_FILE"]) delete process.env[key];
  },

  async broker() {
    const fresh = (name) => {
      const { repo } = freshRepo(name);
      g(repo, "switch", "-q", "-c", "factory/T-9");
      return { repo, before: snapshot(repo) };
    };
    const opts = (before, extra = {}) => ({ branch: "factory/T-9", guardBefore: before, runId: "T-9/implement-0", message: "feat: x", ...extra });
    let { repo, before } = fresh("broker-ok");
    writeFileSync(join(repo, "src", "feature.js"), "export const value = 42;\n");
    const first = brokerCommit(repo, opts(before));
    const again = brokerCommit(repo, opts(before));
    check("B broker commits the edits once, as factory-broker, with the run trailer", first.ok && first.commit && g(repo, "log", "-1", "--format=%cn|%B").startsWith("factory-broker|feat: x") && g(repo, "log", "-1", "--format=%B").includes("Factory-Run: T-9/implement-0"));
    check("B rerun after a crash adopts the commit instead of committing twice", again.ok && again.adopted === true && again.commit === first.commit && g(repo, "rev-list", "--count", "main..factory/T-9") === "1");
    ({ repo, before } = fresh("broker-agent-commit"));
    writeFileSync(join(repo, "src", "feature.js"), "export const value = 1;\n");
    g(repo, "commit", "-qam", "agent commit");
    check("B a commit made by the implementer is refused", brokerCommit(repo, opts(before)).ok === false);
    ({ repo, before } = fresh("broker-workflow"));
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\n");
    check("B change to a protected path (.github/workflows) is refused", /protected path/.test(brokerCommit(repo, opts(before)).reason ?? ""));
    ({ repo, before } = fresh("broker-tracked-workflow"));
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: push\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "workflow on branch");
    before = snapshot(repo);
    writeFileSync(join(repo, ".github", "workflows", "ci.yml"), "on: pull_request\n");
    const tracked = brokerCommit(repo, opts(before));
    check("B modified tracked protected file is refused (porcelain status column kept)", /\.github\/workflows\/ci\.yml: protected path/.test(tracked.reason ?? ""), tracked.reason);
    ({ repo, before } = fresh("broker-paths"));
    writeFileSync(join(repo, "src", "feature.js"), "export const value = 5;\n");
    check("B broker reports exact changed paths", JSON.stringify(brokerCommit(repo, opts(before)).files) === '["src/feature.js"]');
    ({ repo, before } = fresh("broker-symlink"));
    spawnSync("ln", ["-s", scratch, join(repo, "escape")]);
    check("B symlink leaving the workspace is refused", /symlink leaves/.test(brokerCommit(repo, opts(before)).reason ?? ""));
    ({ repo, before } = fresh("broker-secret"));
    writeFileSync(join(repo, "src", "key.txt"), `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----\nnot a real key, contract fixture\n`);
    check("B content shaped like a credential is refused", /credential/.test(brokerCommit(repo, opts(before)).reason ?? ""));
    ({ repo, before } = fresh("broker-hook"));
    writeFileSync(join(repo, ".git", "hooks", "post-commit"), "#!/bin/sh\necho planted\n", { mode: 0o755 });
    writeFileSync(join(repo, "src", "feature.js"), "export const value = 3;\n");
    check("B tampered hooks stop the broker before it commits", /git hooks changed/.test(brokerCommit(repo, opts(before)).reason ?? "") && g(repo, "rev-list", "--count", "main..factory/T-9") === "0");
    check("B commit subject comes from the FACTORY_COMMIT line, one line, bounded", commitMessage("x\nFACTORY_COMMIT: feat: add  a\tthing\n", "fallback") === "feat: add  a thing" && commitMessage("no line", "fallback") === "fallback");
  },

  async isolation() {
    const { repo } = freshRepo("iso");
    const outside = join(scratch, "outside-canary");
    mkdirSync(outside);
    writeFileSync(join(repo, "probe.mjs"), [
      'import { writeFileSync } from "node:fs";',
      "const r = {};",
      'for (const [k, p] of [["ws", "ok.txt"], ["git", ".git/canary"], ["out", process.env.OUT + "/x"]]) { try { writeFileSync(p, "x"); r[k] = "allowed"; } catch (e) { r[k] = e.code; } }',
      'console.log("PROBE " + JSON.stringify(r));',
    ].join("\n"));
    const res = await runTestsIsolated({ workspace: repo, command: ["node", "probe.mjs"], image: "node:22-alpine", label: "contract-iso", attempt: 1, env: { OUT: outside } });
    const probe = JSON.parse(/PROBE (\{.*\})/.exec(res.tail)?.[1] ?? "{}");
    check("I container test run may write the workspace", probe.ws === "allowed", res.tail);
    check("I container test run cannot write .git (read-only mount)", probe.git === "EROFS");
    check("I container test run cannot reach host paths outside the workspace", probe.out === "ENOENT" && readdirSync(outside).length === 0);
    const args = dockerArgs({ workspace: repo, command: ["npm", "test"], image: "node:22-alpine", name: "n", label: "l" });
    check("I container is offline, read-only root, no capabilities, unprivileged", pair(args, "--network", "none") && args.includes("--read-only") && pair(args, "--cap-drop", "ALL") && pair(args, "--security-opt", "no-new-privileges") && args.includes(`${join(repo, ".git")}:/work/.git:ro`));
    const slow = await runTestsIsolated({ workspace: repo, command: ["node", "-e", "setInterval(()=>{},1000)"], image: "node:22-alpine", label: "contract-iso", attempt: 2, timeoutMs: 2000 });
    check("I test timeout kills the container and leaves none behind", slow.status === "timeout" && slow.containersAfter === 0);
    let refused = null;
    try { dockerArgs({ workspace: repo, command: [], image: "node; rm -rf /", name: "n", label: "l" }); } catch (error) { refused = error.message; }
    check("I non-reference test image refused", /plain image reference/.test(refused ?? ""));
  },

  async review() {
    const { repo } = freshRepo("rev");
    const base = g(repo, "rev-parse", "HEAD");
    mkdirSync(join(repo, ".claude"), { recursive: true });
    mkdirSync(join(repo, ".scratch"), { recursive: true });
    writeFileSync(join(repo, ".claude", "settings.json"), '{"hooks":{}}\n');
    writeFileSync(join(repo, ".scratch", "issue.md"), "value must be 42\n");
    writeFileSync(join(repo, "src", "feature.js"), "export const value = 42;\n");
    g(repo, "add", "-A");
    g(repo, "commit", "-qm", "change");
    const head = g(repo, "rev-parse", "HEAD");
    const root = join(ws, ".factory-review", "T-R");
    const meta = prepareSnapshot(repo, { base, head, issue: ".scratch/issue.md", root });
    check("R snapshot is pinned to the head SHA", meta.head === head && meta.base === base);
    check("R trusted diff and requirements are prepared", readFileSync(join(meta.dir, "diff.patch"), "utf8").includes("+export const value = 42;") && readFileSync(join(meta.dir, "requirements.md"), "utf8").includes("value must be 42"));
    check("R agent config is stripped from the snapshot", meta.stripped.includes(".claude") && !existsSync(join(meta.src, ".claude")));
    let writeError = null;
    try { writeFileSync(join(meta.src, "src", "feature.js"), "tampered\n"); } catch (error) { writeError = error.code; }
    check("R snapshot files are read-only", writeError === "EACCES");
    const rv = await run("codex", "review", meta.src, { FAKE_MODE: "review-write" });
    check("R reviewer write attempt in the snapshot fails and leaves it unchanged", !existsSync(join(meta.src, "REVIEW_WAS_HERE.txt")) && checkSnapshot(meta).unchanged && pair(rv.launches[0].args, "-s", "read-only"));
    check("R preparing the same head again reuses the snapshot", prepareSnapshot(repo, { base, head, issue: ".scratch/issue.md", root }).hash === meta.hash);
    chmodSync(join(meta.src, "src", "feature.js"), 0o644);
    writeFileSync(join(meta.src, "src", "feature.js"), "tampered\n");
    check("R a changed snapshot is detected after review", checkSnapshot(meta).unchanged === false);
    const dr = await run("claude-denyread", "review", repo);
    const drProfile = JSON.parse(readFileSync(dr.result.settingsPath, "utf8"));
    check("R claude deny-read paths become Read deny rules", drProfile.permissions.deny.includes(`Read(/${join(scratch, "private")}/**)`));
    const di = await run("claude-denyread", "implement", repo, { FAKE_MODE: "implement-edit" });
    const diProfile = JSON.parse(readFileSync(di.result.settingsPath, "utf8"));
    check("R claude deny-read paths reach the shell sandbox in implement mode", (diProfile.sandbox?.filesystem?.denyRead ?? []).includes(join(scratch, "private")));
  },

  async skillpolicy() {
    const home = join(scratch, "plugins", "matt");
    mkdirSync(join(home, ".agents", "skills", "implement"), { recursive: true });
    mkdirSync(join(scratch, "elsewhere", "other"), { recursive: true });
    for (const p of [join(home, ".agents", "skills", "implement", "SKILL.md"), join(scratch, "elsewhere", "other", "SKILL.md")]) writeFileSync(p, "x\n");
    const policy = skillOverrides([
      { name: "implement", path: join(home, ".agents", "skills", "implement", "SKILL.md"), scope: "user" },
      { name: "other", path: join(scratch, "elsewhere", "other", "SKILL.md"), scope: "user" },
    ], home);
    check("S skills outside the Factory skills home are disabled, pinned ones kept", policy.allowed.map((s) => s.name).join() === "implement" && policy.disabled.map((s) => s.name).join() === "other");
    check("S overrides use Codex skills.config and disable plugins", policy.overrides[0] === "features.plugins=false" && policy.overrides[1] === `skills.config=[{path=${JSON.stringify(join(scratch, "elsewhere", "other", "SKILL.md"))},enabled=false}]`);
    const argv = relayArgv(loadProfiles(profilesPath).workers["codex-skilled"], { mode: "implement", workspace: ws, brief: "b", outDir: "o", codexOverrides: policy.overrides });
    check("S codex worker gets the Factory HOME and the overrides", pair(argv, "--home", realpathSync(home)) && pair(argv, "--codex-config", "features.plugins=false"));
  },
  opencode: async () => {
    const profiles = loadProfiles(profilesPath);
    const doc = structuredClone(profilesDoc);
    doc.workers.oc.codexHome = conf;
    writeFileSync(join(conf, "oc-variant.json"), JSON.stringify(doc), { mode: 0o600 });
    let refusedHome = null;
    try { loadProfiles(join(conf, "oc-variant.json")); } catch (error) { refusedHome = error.message; }
    check("O opencode worker refuses codexHome", /does not apply/.test(refusedHome ?? ""), refusedHome ?? "did not throw");
    const review = relayArgv({ ...profiles.workers.oc, effort: "high" }, { mode: "review", workspace: ws, brief: "b", outDir: "o" });
    check("O review argv: bin, seatbelt, read-only, variant", pair(review, "--opencode-bin", join(binDir, "opencode")) && review.includes("--seatbelt") && review.includes("--read-only") && pair(review, "--variant", "high") && !review.includes("--effort"));
    const impl = relayArgv(profiles.workers.oc, { mode: "implement", workspace: ws, brief: "b", outDir: "o" });
    check("O implement argv: --implement, deny-read, no variant for default", impl.includes("--implement") && pair(impl, "--deny-read", join(scratch, "private")) && !impl.includes("--variant"));
    const repo = join(ws, "oc-repo");
    mkdirSync(repo, { recursive: true });
    g(repo, "init", "-q");
    mkdirSync(join(scratch, "private"), { recursive: true });
    writeFileSync(join(scratch, "private", "token"), "secret");
    const outside = join(process.env.HOME, `.factory-contract-probe-${process.pid}`);
    writeFileSync(join(scratch, "fake-oc.json"), JSON.stringify({ outside, secret: join(scratch, "private", "token") }));
    const runOc = async (mode, tag = "") => {
      const outDir = join(scratch, "out", `oc-${mode}${tag}`);
      const argv = relayArgv(profiles.workers.oc, { mode, workspace: repo, brief: brief(`factory contract brief${tag}`), outDir });
      spawnSync(process.execPath, argv, { env: { ...process.env, ANTHROPIC_API_KEY: "leak" }, encoding: "utf8" });
      return existsSync(join(outDir, "result.json")) ? JSON.parse(readFileSync(join(outDir, "result.json"), "utf8")) : null;
    };
    const probeOf = (result) => JSON.parse(/done (\{.*\})/s.exec(result?.finalMessage ?? "")?.[1] ?? "{}");
    if (process.platform === "darwin") {
      const result = await runOc("implement");
      const probe = probeOf(result);
      rmSync(outside, { force: true });
      check("O implement completes with worker and seatbelt recorded", result?.status === "completed" && result.worker === "oc" && result.mode === "implement" && !!result.seatbelt);
      check("O seatbelt: workspace writable, .git and HOME not, secret unreadable", probe.ws === "written" && probe.git === "EPERM" && probe.outside === "EPERM" && probe.secret === "EPERM", JSON.stringify({ ...probe, seen: undefined }));
      const config = JSON.parse(readFileSync(join(probe.seen.env.XDG_CONFIG_HOME, "opencode", "opencode.json"), "utf8"));
      check("O child env is minimal and config isolated with git push denied", probe.seen.env.ANTHROPIC_API_KEY === null && config.permission.bash["git push*"] === "deny" && probe.seen.args.includes("--auto"));
      const ro = await runOc("review");
      const roProbe = probeOf(ro);
      check("O review: plan agent, workspace not writable, no --auto", ro?.agent === "plan" && roProbe.ws === "EPERM" && !roProbe.seen.args.includes("--auto"), JSON.stringify({ ...roProbe, seen: undefined }));
    }
    const refused = await runOc("review", " FAKE_OC=error402");
    check("O provider 402 with no report is a failure", refused?.status === "failed" && refused.providerError?.statusCode === 402);
    const snap = fromRelayResult(refused);
    check("O provider refusal becomes a cooldown observation", snap?.provider === "opencode" && snap.limitReached === "provider_refused" && snap.measured === false);
  },
};

try {
  for (const [name, fn] of Object.entries(groups)) {
    if (only && !only.has(name)) continue;
    console.log(`# ${name}`);
    await fn();
  }
  check("contract run left no stray files in the fork", !existsSync(join(ROOT, "src")));
} finally {
  spawnSync("chmod", ["-R", "u+w", scratch]);
  rmSync(scratch, { recursive: true, force: true });
  rmSync(join(ROOT, "test", "factory", "fixtures", "skills"), { recursive: true, force: true });
}
console.log(`\nfactory contract: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

#!/usr/bin/env node
// Fake claude/codex for Factory contract tests. Behaviour comes from FAKE_MODE; every launch is
// appended to FAKE_LOG so tests can count invocations and inspect argv, cwd, env and brief.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync, spawn } = require("node:child_process");

const args = process.argv.slice(2);
const provider = process.env.FAKE_PROVIDER || (args[0] === "exec" || args[0] === "app-server" ? "codex" : "claude");
if (args.includes("--version")) {
  console.log(`${provider}-fake 9.9.9`);
  process.exit(0);
}
const brief = fs.readFileSync(0, "utf8");
const isReview = (args.includes("--permission-mode") && args[args.indexOf("--permission-mode") + 1] === "plan") ||
  (args.includes("-s") && args[args.indexOf("-s") + 1] === "read-only");
const requested = process.env.FAKE_MODE || "success";
const mode = isReview && !["review-write", "hang", "no-result"].includes(requested) ? (process.env.FAKE_REVIEW || "review-pass") : requested;
const SECRET_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_BASE_URL"];
const record = {
  provider, bin: process.argv[1], args, cwd: process.cwd(), brief, mode,
  env: {
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? null,
    CODEX_HOME: process.env.CODEX_HOME ?? null,
    CLAUDECODE: process.env.CLAUDECODE ?? null,
    secretsSeen: SECRET_KEYS.filter((key) => process.env[key] !== undefined),
  },
};
if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${JSON.stringify(record)}\n`);

const g = (...a) => execFileSync("git", a, { encoding: "utf8" }).trim();
const writeFeature = (value) => {
  fs.mkdirSync("src", { recursive: true });
  fs.writeFileSync("src/feature.js", `export const value = ${value};\n`);
  fs.appendFileSync("src/changes.log", `${process.pid} ${Date.now()}\n`);
};
const commit = (message) => {
  g("add", "-A");
  g("-c", "user.email=fake@agent", "-c", "user.name=fake-agent", "commit", "-q", "-m", message);
};
const counter = () => {
  const file = process.env.FAKE_COUNTER;
  const n = file && fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) + 1 : 1;
  if (file) fs.writeFileSync(file, String(n));
  return n;
};

const SESSION = "aaaaaaaa-1111-4111-8111-000000000001";
const THREAD = "0199aaaa-2222-7222-8222-000000000002";
const resumedFrom = args.includes("--resume") ? args[args.indexOf("--resume") + 1] : args[args.indexOf("resume") + 1] ?? null;
let final = `fake ${provider} done (${mode})`;

switch (mode) {
  case "implement-commit": writeFeature(42); commit("feat: value 42"); break;
  case "implement-nocommit": writeFeature(42); break;
  case "buggy-then-fix": {
    const n = counter();
    writeFeature(n === 1 ? 41 : 42);
    commit(n === 1 ? "feat: value" : "fix: value 42");
    break;
  }
  case "tamper-main": writeFeature(42); commit("feat"); g("branch", "-f", "main", "HEAD"); break;
  case "tamper-new-branch": writeFeature(42); commit("feat"); g("branch", "sneaky"); break;
  case "tamper-hook": {
    writeFeature(42); commit("feat");
    const hooks = path.join(g("rev-parse", "--git-common-dir"), "hooks");
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, "post-checkout"), "#!/bin/sh\necho pwned\n", { mode: 0o755 });
    break;
  }
  case "tamper-config": writeFeature(42); commit("feat"); g("config", "core.fsmonitor", "touch /tmp/factory-poc-pwned"); break;
  case "rewrite-history": g("reset", "-q", "--hard", "HEAD~1"); writeFeature(42); commit("rewritten"); break;
  case "switch-branch": g("switch", "-q", "-c", "elsewhere"); writeFeature(42); commit("feat"); break;
  case "review-write": fs.writeFileSync("REVIEW_WAS_HERE.txt", "x\n"); final = "```json\n{\"schema\":\"factory.single-review.v1\",\"verdict\":\"pass\",\"findings\":[]}\n```"; break;
  case "review-pass": final = "## Standards\nok\n## Spec\nok\n```json\n{\"schema\":\"factory.single-review.v1\",\"verdict\":\"pass\",\"findings\":[]}\n```"; break;
  case "review-block": final = "```json\n{\"schema\":\"factory.single-review.v1\",\"verdict\":\"changes-requested\",\"findings\":[{\"axis\":\"spec\",\"severity\":\"blocking\",\"claim\":\"value must be 42\"}]}\n```"; break;
  case "hang": {
    const grandchild = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
    if (process.env.FAKE_PID_FILE) fs.writeFileSync(process.env.FAKE_PID_FILE, String(grandchild.pid));
    setInterval(() => {}, 1000);
    return;
  }
  case "no-result": process.exit(1);
  default: break;
}

if (provider === "claude") {
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  if (configDir && process.env.FAKE_TRANSCRIPT !== "0") {
    const dir = path.join(configDir, "projects", "fake-project");
    fs.mkdirSync(dir, { recursive: true });
    const plugin = args.includes("--plugin-dir") ? args[args.indexOf("--plugin-dir") + 1] : "/none";
    fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), [
      JSON.stringify({ type: "user", message: { content: "<command-name>/mattpocock-skills:implement</command-name>" } }),
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: `Base directory for this skill: ${plugin}/skills/engineering/implement\n\nImplement…` }] } }),
    ].join("\n"));
  }
  const emit = (event) => console.log(JSON.stringify({ session_id: SESSION, ...event }));
  emit({ type: "system", subtype: "init", permissionMode: args[args.indexOf("--permission-mode") + 1] ?? "acceptEdits", mcp_servers: [] });
  emit({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "Skill", input: { skill: "tdd" } }] } });
  emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: 1900000000, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.31, resetsAt: 1900000000 }, seven_day: { utilization: 0.05, resetsAt: 1900500000 } } } });
  emit({ type: "result", subtype: "success", is_error: false, result: final, num_turns: 2, total_cost_usd: 0, usage: { input_tokens: 1, output_tokens: 1 }, permission_denials: mode === "mcp-denied" ? [{ tool_name: "mcp__mock__secret" }] : [], resumed_from: resumedFrom });
} else {
  const home = process.env.CODEX_HOME;
  if (home) {
    const dir = path.join(home, "sessions", "2026", "01", "01");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `rollout-2026-01-01T00-00-00-${THREAD}.jsonl`), [
      JSON.stringify({ type: "response_item", payload: { content: [{ text: `<skill>\n<name>implement</name>\n<path>${home}/skills/implement/SKILL.md</path>\n---` }] } }),
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: null, rate_limits: { limit_id: "codex", primary: { used_percent: 12, window_minutes: 10080, resets_at: 1900600000 }, secondary: null, plan_type: "fake", rate_limit_reached_type: null } } }),
    ].join("\n"));
  }
  const out = args[args.indexOf("-o") + 1];
  console.log(JSON.stringify({ type: "thread.started", thread_id: THREAD }));
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  if (out) fs.writeFileSync(out, final);
}

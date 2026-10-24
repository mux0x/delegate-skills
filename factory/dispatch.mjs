#!/usr/bin/env node
// Dispatch one brief to one trusted worker profile through the unmodified relay contract.
//   node factory/dispatch.mjs --profiles <file> --worker <id> --mode implement|review \
//        --cd <workspace> --brief <file> --out-dir <dir> [--session <id>]
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, resolveWorker, workerEnv } from "./profiles.mjs";
import { listCodexSkills, skillOverrides } from "./skills.mjs";
import { claudeUsage, codexUsage, gate } from "./capacity.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const relayPath = (provider) => join(ROOT, "skills", `${provider}-delegate`, "scripts", "relay.mjs");

export function relayArgv(worker, { mode, workspace, brief, outDir, session, codexOverrides = [] }) {
  const argv = [relayPath(worker.provider), "--brief", brief, "--cd", workspace, "--out-dir", outDir, "--worker", worker.id, "--timeout", worker.timeout];
  if (worker.model) argv.push("--model", worker.model);
  // OpenCode's reasoning dial is --variant; "default" leaves the model's own default.
  if (worker.effort && worker.provider === "opencode") { if (worker.effort !== "default") argv.push("--variant", worker.effort); }
  else if (worker.effort) argv.push("--effort", worker.effort);
  if (session) {
    if (!worker.resume) throw new Error(`worker ${worker.id} does not allow resume`);
    argv.push("--session", session);
  }
  if (worker.provider === "claude") {
    argv.push("--claude-bin", worker.bin);
    if (worker.profileDir) argv.push("--config-dir", worker.profileDir);
    for (const path of worker.denyRead) argv.push("--deny-read", path);
    if (mode === "review") argv.push("--read-only");
    else {
      argv.push("--implement");
      for (const dir of worker.pluginDirs) argv.push("--plugin-dir", dir);
      if (worker.mcp) {
        argv.push("--mcp-config", worker.mcp.config);
        for (const tool of worker.mcp.allowTools) argv.push("--allow-mcp-tool", tool);
      }
    }
  } else if (worker.provider === "opencode") {
    // No OS sandbox of its own: the relay runs it under sandbox-exec (writes only in the
    // workspace, never .git; credentials and other profiles unreadable).
    argv.push("--opencode-bin", worker.bin, "--seatbelt");
    if (worker.skillsHome) argv.push("--home", worker.skillsHome);
    for (const path of worker.denyRead) argv.push("--deny-read", path);
    argv.push(mode === "review" ? "--read-only" : "--implement");
  } else {
    argv.push("--codex-bin", worker.bin, "--ignore-user-config");
    if (worker.profileDir) argv.push("--codex-home", worker.profileDir);
    if (worker.skillsHome) argv.push("--home", worker.skillsHome);
    if (mode === "review" && !existsSync(join(workspace, ".git"))) argv.push("--skip-git-repo-check");
    for (const override of codexOverrides) argv.push("--codex-config", override);
    if (mode === "review") argv.push("--read-only");
    else {
      argv.push("--implement");
      if (worker.mcp) argv.push("--mcp-config", worker.mcp.config);
    }
  }
  return argv;
}

// Official, inference-free quota read for one worker profile, gated fail-closed.
export async function capacityFor(profilesPath, workerId) {
  const worker = loadProfiles(profilesPath).workers[workerId];
  if (!worker) throw new Error(`unknown worker "${workerId}"`);
  const snapshot = worker.provider === "claude" ? claudeUsage(worker.bin, worker.profileDir) : await codexUsage(worker.bin, worker.profileDir);
  return { worker: workerId, snapshot, gate: gate(snapshot) };
}

export async function codexSkillPolicy(worker, workspace, env = process.env) {
  if (worker.provider !== "codex" || !worker.skillsHome) return null;
  const skills = await listCodexSkills({ bin: worker.bin, codexHome: worker.profileDir, home: worker.skillsHome, cwd: workspace, env: workerEnv(env) });
  return skillOverrides(skills, worker.skillsHome);
}

export async function dispatch({ profilesPath, workerId, mode, cd, brief, outDir, session = null, env = process.env, onSpawn = null }) {
  const profiles = loadProfiles(profilesPath);
  const { worker, workspace } = resolveWorker(profiles, workerId, mode, cd);
  const policy = await codexSkillPolicy(worker, workspace, env);
  if (policy) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "skill-policy.json"), `${JSON.stringify(policy, null, 2)}\n`);
  }
  const argv = relayArgv(worker, { mode, workspace, brief, outDir, session, codexOverrides: policy?.overrides ?? [] });
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, argv, { env: workerEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    if (onSpawn) onSpawn(child.pid);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      const resultFile = join(outDir, "result.json");
      const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
      resolveRun({ exitCode: code, result, stdout, stderr, argv, skillPolicy: policy });
    });
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const at = args.indexOf(flag);
    return at === -1 ? null : args[at + 1];
  };
  const missing = ["--profiles", "--worker", "--mode", "--cd", "--brief", "--out-dir"].filter((flag) => !get(flag));
  if (missing.length) {
    process.stderr.write(`dispatch: missing ${missing.join(", ")}\n`);
    process.exit(2);
  }
  try {
    const run = await dispatch({
      profilesPath: get("--profiles"), workerId: get("--worker"), mode: get("--mode"),
      cd: get("--cd"), brief: get("--brief"), outDir: get("--out-dir"), session: get("--session"),
    });
    process.stdout.write(run.stdout);
    process.stderr.write(run.stderr);
    process.exit(run.exitCode ?? 1);
  } catch (error) {
    process.stderr.write(`dispatch: ${error.message}\n`);
    process.exit(2);
  }
}

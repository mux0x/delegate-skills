#!/usr/bin/env node
// Dispatch one brief to one trusted worker profile through the unmodified relay contract.
//   node factory/dispatch.mjs --profiles <file> --worker <id> --mode implement|review \
//        --cd <workspace> --brief <file> --out-dir <dir> [--session <id>]
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadProfiles, resolveWorker, workerEnv } from "./profiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const relayPath = (provider) => join(ROOT, "skills", `${provider}-delegate`, "scripts", "relay.mjs");

export function relayArgv(worker, { mode, workspace, brief, outDir, session }) {
  const argv = [relayPath(worker.provider), "--brief", brief, "--cd", workspace, "--out-dir", outDir, "--worker", worker.id, "--timeout", worker.timeout];
  if (worker.model) argv.push("--model", worker.model);
  if (worker.effort) argv.push("--effort", worker.effort);
  if (session) {
    if (!worker.resume) throw new Error(`worker ${worker.id} does not allow resume`);
    argv.push("--session", session);
  }
  if (worker.provider === "claude") {
    argv.push("--claude-bin", worker.bin);
    if (worker.profileDir) argv.push("--config-dir", worker.profileDir);
    if (mode === "review") argv.push("--read-only");
    else {
      argv.push("--implement");
      for (const dir of worker.pluginDirs) argv.push("--plugin-dir", dir);
      if (worker.mcp) {
        argv.push("--mcp-config", worker.mcp.config);
        for (const tool of worker.mcp.allowTools) argv.push("--allow-mcp-tool", tool);
      }
    }
  } else {
    argv.push("--codex-bin", worker.bin, "--ignore-user-config");
    if (worker.profileDir) argv.push("--codex-home", worker.profileDir);
    if (mode === "review") argv.push("--read-only");
    else {
      argv.push("--implement");
      if (worker.mcp) argv.push("--mcp-config", worker.mcp.config);
    }
  }
  return argv;
}

export function dispatch({ profilesPath, workerId, mode, cd, brief, outDir, session = null, env = process.env }) {
  const profiles = loadProfiles(profilesPath);
  const { worker, workspace } = resolveWorker(profiles, workerId, mode, cd);
  const argv = relayArgv(worker, { mode, workspace, brief, outDir, session });
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, argv, { env: workerEnv(env), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      const resultFile = join(outDir, "result.json");
      const result = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, "utf8")) : null;
      resolveRun({ exitCode: code, result, stdout, stderr, argv });
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

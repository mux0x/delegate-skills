// Project tests are agent-written code, so the Factory runs them in a throwaway container that sees
// only the ticket workspace: no network, no host home, no CLI profiles, .git mounted read-only,
// read-only root filesystem, no capabilities. One container per attempt, labelled by ticket so
// a restarted Factory removes leftovers before it runs again.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const DOCKER = "docker";
const SAFE_IMAGE = /^[a-z0-9][a-z0-9._\/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/;

export function dockerArgs({ workspace, command, image, name, label, env = {}, memory = "1g", pids = 256 }) {
  if (!SAFE_IMAGE.test(image)) throw new Error(`test image "${image}" is not a plain image reference`);
  const args = [
    "run", "--rm", "--name", name, "--label", `factory.ticket=${label}`,
    "--network", "none", "--read-only", "--tmpfs", "/tmp:rw,exec,size=512m",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", String(pids), "--memory", memory,
    "--user", `${process.getuid()}:${process.getgid()}`,
    "-e", "HOME=/tmp", "-e", "CI=1", "-e", "npm_config_cache=/tmp/.npm", "-e", "npm_config_update_notifier=false",
    "-v", `${workspace}:/work:rw`,
  ];
  if (existsSync(join(workspace, ".git"))) args.push("-v", `${join(workspace, ".git")}:/work/.git:ro`);
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push("-w", "/work", image, ...command);
  return args;
}

export function removeLeftovers(label) {
  const ids = spawnSync(DOCKER, ["ps", "-aq", "--filter", `label=factory.ticket=${label}`], { encoding: "utf8" }).stdout.split("\n").filter(Boolean);
  if (ids.length) spawnSync(DOCKER, ["rm", "-f", ...ids], { stdio: "ignore" });
  return ids.length;
}

export function runTestsIsolated({ workspace, command, image, label, attempt, timeoutMs = 300_000, env = {} }) {
  const leftovers = removeLeftovers(label);
  const name = `factory-test-${label}-${attempt}-${process.pid}`.replace(/[^A-Za-z0-9_.-]/g, "-");
  const args = dockerArgs({ workspace, command, image, name, label, env });
  return new Promise((resolveRun) => {
    const child = spawn(DOCKER, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      spawnSync(DOCKER, ["kill", name], { stdio: "ignore" });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const remaining = removeLeftovers(label);
      resolveRun({
        runner: "docker", image, passed: !timedOut && code === 0, exitCode: code, status: timedOut ? "timeout" : code === 0 ? "passed" : "failed",
        leftoversRemoved: leftovers, containersAfter: remaining, tail: output.split("\n").slice(-40).join("\n"),
      });
    });
  });
}

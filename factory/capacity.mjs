#!/usr/bin/env node
// Capacity telemetry from official local CLI interfaces only. Every snapshot says where it came
// from and whether it is a measurement; the dispatch gate refuses anything else.
//   node factory/capacity.mjs claude <claude-bin> [<config-dir>]
//   node factory/capacity.mjs codex <codex-bin> [<codex-home>]
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { workerEnv } from "./profiles.mjs";

const WINDOW_BY_MINUTES = { 300: "five_hour", 10080: "seven_day" };

// `claude -p /usage` is answered locally (synthetic message, zero turns, zero cost), so it
// measures quota without spending it. Its text is human-formatted; the parser is strict and
// reports unparsed rather than guessing.
export function parseClaudeUsage(text) {
  const window = (label) => {
    const match = new RegExp(`${label}: (\\d+(?:\\.\\d+)?)% used(?: · resets ([^\\n]+))?`).exec(text);
    return match ? { usedPercent: Number(match[1]), resetsText: match[2]?.trim() ?? null } : null;
  };
  return { five_hour: window("Current session"), seven_day: window("Current week \\(all models\\)") };
}

export function claudeUsage(bin, configDir = null) {
  const env = workerEnv();
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  const run = spawnSync(bin, ["-p", "--output-format", "json", "--setting-sources", "project,local", "--strict-mcp-config", "--tools", ""], {
    input: "/usage", encoding: "utf8", env, timeout: 60_000,
  });
  const observedAt = new Date().toISOString();
  let doc;
  try { doc = JSON.parse(run.stdout); } catch { return { provider: "claude", measured: false, observedAt, error: "unparseable /usage output" }; }
  const inference = !(doc.num_turns === 0 && doc.total_cost_usd === 0);
  const windows = parseClaudeUsage(doc.result || "");
  return {
    provider: "claude",
    source: "claude -p /usage",
    measured: !inference && Boolean(windows.five_hour && windows.seven_day),
    inference,
    observedAt,
    windows,
  };
}

// The App Server's account/rateLimits/read answers from the account, not from a model turn.
export function codexUsage(bin, codexHome = null, timeoutMs = 20_000) {
  const env = workerEnv();
  if (codexHome) env.CODEX_HOME = codexHome;
  return new Promise((resolveUsage) => {
    const child = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const finish = (value) => {
      clearTimeout(timer);
      child.kill();
      resolveUsage({ provider: "codex", source: "codex app-server account/rateLimits/read", observedAt: new Date().toISOString(), ...value });
    };
    const timer = setTimeout(() => finish({ measured: false, error: "app-server did not answer" }), timeoutMs);
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (error) => finish({ measured: false, error: error.message }));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        } else if (message.id === 2) {
          if (message.error) return finish({ measured: false, error: message.error.message });
          return finish({ measured: true, inference: false, ...codexWindows(message.result.rateLimits) });
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "software-factory", version: "0.0.1" } } });
  });
}

export function codexWindows(limits) {
  const windows = {};
  for (const slot of [limits?.primary, limits?.secondary]) {
    if (!slot) continue;
    const name = WINDOW_BY_MINUTES[slot.windowDurationMins ?? slot.window_minutes] ?? `${slot.windowDurationMins ?? slot.window_minutes}m`;
    windows[name] = { usedPercent: slot.usedPercent ?? slot.used_percent, resetsAt: new Date((slot.resetsAt ?? slot.resets_at) * 1000).toISOString() };
  }
  return { windows, limitReached: limits?.rateLimitReachedType ?? limits?.rate_limit_reached_type ?? null, plan: limits?.planType ?? limits?.plan_type ?? null };
}

// Passive telemetry carried by every relay result: no extra call at all.
export function fromRelayResult(result) {
  if (result?.rateLimit?.unifiedWindows) {
    const windows = {};
    for (const [name, slot] of Object.entries(result.rateLimit.unifiedWindows)) {
      windows[name] = { usedPercent: Math.round(slot.utilization * 1000) / 10, resetsAt: new Date(slot.resetsAt * 1000).toISOString() };
    }
    return { provider: "claude", source: "relay rate_limit_event", measured: true, inference: false, observedAt: result.finishedAt, windows, limitReached: result.rateLimit.status === "allowed" ? null : result.rateLimit.status };
  }
  if (result?.rateLimits) {
    return { provider: "codex", source: "relay rollout token_count", measured: true, inference: false, observedAt: result.finishedAt, ...codexWindows(result.rateLimits) };
  }
  return null;
}

export function gate(snapshot, { maxAgeSeconds = 900, minHeadroomPercent = 15, now = Date.now() } = {}) {
  if (!snapshot || snapshot.measured !== true) return { dispatch: false, state: "CAPACITY_SYNC_REQUIRED", reason: "no measured telemetry (estimates never authorize dispatch)" };
  const age = (now - Date.parse(snapshot.observedAt)) / 1000;
  if (!(age <= maxAgeSeconds)) return { dispatch: false, state: "CAPACITY_SYNC_REQUIRED", reason: `telemetry is ${Math.round(age)}s old (max ${maxAgeSeconds}s)` };
  if (snapshot.limitReached) return { dispatch: false, state: "RATE_LIMITED", reason: `provider reports ${snapshot.limitReached}` };
  const windows = Object.entries(snapshot.windows || {});
  if (!windows.length) return { dispatch: false, state: "CAPACITY_SYNC_REQUIRED", reason: "telemetry has no windows" };
  for (const [name, slot] of windows) {
    if (slot == null || typeof slot.usedPercent !== "number") return { dispatch: false, state: "CAPACITY_SYNC_REQUIRED", reason: `${name} window unreadable` };
    if (100 - slot.usedPercent < minHeadroomPercent) return { dispatch: false, state: "CAPACITY_LOW", reason: `${name} at ${slot.usedPercent}% used` };
  }
  return { dispatch: true, state: "OK", reason: "measured headroom above threshold" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [provider, bin, dir] = process.argv.slice(2);
  const snapshot = provider === "claude" ? claudeUsage(bin, dir) : await codexUsage(bin, dir);
  console.log(JSON.stringify({ snapshot, gate: gate(snapshot) }, null, 2));
}

#!/usr/bin/env node
// Fake `opencode`: --version, and `run --format json` reading the brief on stdin.
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.19.4"); process.exit(0); }
const emit = (e) => process.stdout.write(`${JSON.stringify({ sessionID: "ses_fake", ...e })}\n`);
// The Factory gives the child a minimal env, so the fixture reads its knobs from the brief and
// from fake-oc.json beside the scratch bin dir.
const brief = fs.readFileSync(0, "utf8");
const mode = /FAKE_OC=(\w+)/.exec(brief)?.[1] ?? "ok";
const knobs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fake-oc.json"), "utf8"));
const seen = { args, env: { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null } };
if (mode === "error402") {
  emit({ type: "error", error: { name: "APIError", data: { message: "Insufficient balance", statusCode: 402 } } });
  process.exit(0);
}
const probe = {};
for (const [name, target] of [["ws", "edited.txt"], ["git", path.join(".git", "planted")], ["outside", knobs.outside]]) {
  try { fs.writeFileSync(target, "x"); probe[name] = "written"; } catch (e) { probe[name] = e.code; }
}
try { fs.readFileSync(knobs.secret, "utf8"); probe.secret = "read"; } catch (e) { probe.secret = e.code; }
emit({ type: "text", part: { id: "p1", type: "text", text: `done ${JSON.stringify({ ...probe, seen })}` } });

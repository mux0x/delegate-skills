// Predictable Codex skills without touching the user's setup: the worker runs with HOME pointed at a
// Factory-owned directory whose .agents/skills holds the pinned Matt skills, and every other skill
// Codex still discovers (CODEX_HOME skills, system skills, plugin skills) is disabled for the run
// through Codex's documented skills.config override. Discovery uses the App Server's skills/list,
// which runs no model inference.
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";

export function listCodexSkills({ bin, codexHome, home, cwd, env = process.env, timeoutMs = 20_000 }) {
  return new Promise((resolveList, reject) => {
    const childEnv = { ...env, HOME: home };
    if (codexHome) childEnv.CODEX_HOME = codexHome;
    const child = spawn(bin, ["-c", "features.plugins=false", "app-server"], { env: childEnv, stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    const done = (fn) => { clearTimeout(timer); child.kill(); fn(); };
    const timer = setTimeout(() => done(() => reject(new Error("codex app-server skills/list timed out"))), timeoutMs);
    child.on("error", (error) => done(() => reject(error)));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) { send({ method: "initialized" }); send({ id: 2, method: "skills/list", params: { cwds: [cwd] } }); }
        if (message.id === 2) {
          const skills = message.result?.data?.[0]?.skills;
          done(() => (skills ? resolveList(skills.map((s) => ({ name: s.name, path: s.path, scope: s.scope ?? null }))) : reject(new Error("skills/list returned no skills"))));
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "software-factory", version: "0.0.1" } } });
  });
}

const toml = (value) => JSON.stringify(value);

export function skillOverrides(skills, home) {
  const root = `${realpathSync(home)}/`;
  const foreign = skills.filter((s) => !realpathSync(s.path).startsWith(root));
  const allowed = skills.filter((s) => !foreign.includes(s));
  const config = foreign.length ? [`skills.config=[${foreign.map((s) => `{path=${toml(s.path)},enabled=false}`).join(",")}]`] : [];
  return { allowed, disabled: foreign, overrides: ["features.plugins=false", ...config] };
}

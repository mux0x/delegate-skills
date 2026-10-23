// Trusted worker profiles: the Factory, never the ticket or the agent, decides which official
// CLI, which profile directory, which model and which permissions a run gets.
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

export const PROFILES_SCHEMA = "factory.workers.v1";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_MCP_TOOL = /^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$/;
const PROVIDERS = {
  claude: { profileDir: "configDir", envVar: "CLAUDE_CONFIG_DIR" },
  codex: { profileDir: "codexHome", envVar: "CODEX_HOME" },
};
const MODES = new Set(["implement", "review"]);
const WORKER_KEYS = new Set(["provider", "bin", "configDir", "codexHome", "model", "effort", "modes", "pluginDirs", "mcp", "timeout", "resume"]);

// Variables that would switch a subscription CLI onto paid API billing, point it at another
// endpoint, or carry another profile's identity into this one.
export const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CONFIG_DIR", "CLAUDECODE",
  "OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "CODEX_HOME",
];

const isWithin = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

function realDir(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  let real;
  try { real = realpathSync(path); } catch { throw new Error(`${label} not found: ${path}`); }
  if (!statSync(real).isDirectory()) throw new Error(`${label} is not a directory: ${path}`);
  return real;
}

function executable(path, label) {
  if (typeof path !== "string" || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  try {
    if (!statSync(path).isFile()) throw new Error("not a file");
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is missing or not executable: ${path}`);
  }
  return path;
}

export function loadProfiles(path) {
  const stat = statSync(path);
  if (process.platform !== "win32" && (stat.mode & 0o022)) {
    throw new Error(`profiles file ${path} is group/world-writable; refuse to trust it`);
  }
  const doc = JSON.parse(readFileSync(path, "utf8"));
  if (doc.schema !== PROFILES_SCHEMA) throw new Error(`profiles schema must be ${PROFILES_SCHEMA}`);
  const workspaceRoot = realDir(doc.workspaceRoot, "workspaceRoot");
  if (isWithin(workspaceRoot, realpathSync(path))) {
    throw new Error("profiles file must live outside workspaceRoot, where agents cannot edit it");
  }
  if (!doc.workers || typeof doc.workers !== "object") throw new Error("profiles need a workers object");
  const workers = {};
  for (const [id, raw] of Object.entries(doc.workers)) workers[id] = validateWorker(id, raw);
  return { path, workspaceRoot, workers };
}

function validateWorker(id, w) {
  if (!SAFE_ID.test(id)) throw new Error(`worker id "${id}" has unsupported characters`);
  const unknown = Object.keys(w).filter((key) => !WORKER_KEYS.has(key));
  if (unknown.length) throw new Error(`worker ${id}: unknown field(s) ${unknown.join(", ")}`);
  const provider = PROVIDERS[w.provider];
  if (!provider) throw new Error(`worker ${id}: provider must be one of ${Object.keys(PROVIDERS).join(", ")}`);
  const other = w.provider === "claude" ? "codexHome" : "configDir";
  if (w[other] !== undefined) throw new Error(`worker ${id}: ${other} does not apply to ${w.provider}`);
  const modes = w.modes ?? ["review"];
  if (!Array.isArray(modes) || !modes.every((mode) => MODES.has(mode))) throw new Error(`worker ${id}: modes must be implement/review`);
  if (w.pluginDirs !== undefined && w.provider !== "claude") throw new Error(`worker ${id}: pluginDirs is claude-only`);
  const mcp = w.mcp ?? null;
  if (mcp !== null) {
    if (typeof mcp.config !== "string" || !isAbsolute(mcp.config)) throw new Error(`worker ${id}: mcp.config must be an absolute path`);
    if (w.provider === "claude" && !(Array.isArray(mcp.allowTools) && mcp.allowTools.every((tool) => SAFE_MCP_TOOL.test(tool)))) {
      throw new Error(`worker ${id}: mcp.allowTools must list mcp__<server>__<tool> names`);
    }
  }
  return {
    id,
    provider: w.provider,
    bin: executable(w.bin, `worker ${id} bin`),
    profileDir: w[provider.profileDir] === undefined ? null : realDir(w[provider.profileDir], `worker ${id} ${provider.profileDir}`),
    model: w.model ?? null,
    effort: w.effort ?? null,
    modes,
    pluginDirs: (w.pluginDirs ?? []).map((dir) => realDir(dir, `worker ${id} pluginDir`)),
    mcp,
    timeout: w.timeout ?? "30m",
    resume: w.resume !== false,
  };
}

export function workerEnv(base = process.env) {
  const env = { ...base };
  for (const key of STRIPPED_ENV) delete env[key];
  return env;
}

export function resolveWorker(profiles, id, mode, cd) {
  const worker = profiles.workers[id];
  if (!worker) throw new Error(`unknown worker "${id}"`);
  if (!worker.modes.includes(mode)) throw new Error(`worker ${id} is not allowed to ${mode}`);
  const workspace = realDir(cd, "workspace");
  if (!isWithin(profiles.workspaceRoot, workspace)) throw new Error(`workspace ${cd} is outside workspaceRoot`);
  return { worker, workspace };
}

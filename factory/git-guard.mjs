// Git ownership contract: the implementer may commit on its ticket branch and nothing else.
// The guard snapshots the repository before a run and verifies after it. It reads config and
// hooks as files before running git, and runs git with hooks and fsmonitor disabled, so a run
// that planted either cannot execute code in the Factory's unsandboxed process.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const SAFE_GIT = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];

export function git(cwd, args, options = {}) {
  return execFileSync("git", [...SAFE_GIT, ...args], {
    cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, ...options,
  }).trim();
}

function gitDirs(cwd) {
  const pointer = join(cwd, ".git");
  let gitDir = pointer;
  if (existsSync(pointer) && statSync(pointer).isFile()) {
    const match = /^gitdir: (.+)$/m.exec(readFileSync(pointer, "utf8"));
    if (!match) throw new Error(`unreadable .git pointer in ${cwd}`);
    gitDir = isAbsolute(match[1]) ? match[1] : resolve(cwd, match[1]);
  }
  const commonFile = join(gitDir, "commondir");
  const commonDir = existsSync(commonFile) ? resolve(gitDir, readFileSync(commonFile, "utf8").trim()) : gitDir;
  return { gitDir, commonDir };
}

const sha = (data) => createHash("sha256").update(data).digest("hex");
const fileHash = (path) => (existsSync(path) ? sha(readFileSync(path)) : null);

function treeHash(dir) {
  if (!existsSync(dir)) return null;
  const entries = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = statSync(path);
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else entries.push(`${prefix}${name}:${stat.mode.toString(8)}:${sha(readFileSync(path))}`);
    }
  };
  walk(dir, "");
  return sha(entries.join("\n"));
}

export function snapshot(cwd) {
  const { gitDir, commonDir } = gitDirs(cwd);
  const integrity = {
    config: fileHash(join(commonDir, "config")),
    worktreeConfig: fileHash(join(gitDir, "config.worktree")),
    hooks: treeHash(join(commonDir, "hooks")),
    info: treeHash(join(commonDir, "info")),
  };
  const refs = {};
  for (const line of git(cwd, ["for-each-ref", "--format=%(refname) %(objectname)"]).split("\n").filter(Boolean)) {
    const [name, value] = line.split(" ");
    refs[name] = value;
  }
  let head = null;
  try { head = git(cwd, ["symbolic-ref", "-q", "HEAD"]); } catch { head = null; }
  return { integrity, refs, head, headSha: git(cwd, ["rev-parse", "HEAD"]) };
}

export function verify(cwd, before, { branch }) {
  const after = snapshot(cwd);
  const violations = [];
  const ticketRef = `refs/heads/${branch}`;
  for (const [key, value] of Object.entries(before.integrity)) {
    if (after.integrity[key] !== value) violations.push(`git ${key} changed`);
  }
  if (after.head !== ticketRef) violations.push(`HEAD moved to ${after.head ?? "a detached commit"}`);
  for (const name of new Set([...Object.keys(before.refs), ...Object.keys(after.refs)])) {
    if (name === ticketRef || before.refs[name] === after.refs[name]) continue;
    violations.push(`${name} ${before.refs[name] === undefined ? "created" : after.refs[name] === undefined ? "deleted" : "moved"}`);
  }
  const from = before.refs[ticketRef];
  const to = after.refs[ticketRef];
  let commits = [];
  if (from && to && from !== to) {
    try {
      git(cwd, ["merge-base", "--is-ancestor", from, to]);
      commits = git(cwd, ["rev-list", "--reverse", `${from}..${to}`]).split("\n").filter(Boolean);
    } catch {
      violations.push(`${ticketRef} was rewritten (not a fast-forward from ${from.slice(0, 12)})`);
    }
  }
  const dirty = git(cwd, ["status", "--porcelain"]).split("\n").filter(Boolean);
  return { ok: violations.length === 0, violations, commits, dirty, after };
}

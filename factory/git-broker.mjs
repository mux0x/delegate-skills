// Trusted commit broker: implementers only edit files (their sandboxes keep .git read-only); the
// Factory turns a finished run into exactly one commit after checking that git metadata is intact
// and that the change set stays inside the policy. Idempotent: a commit carrying this run's
// Factory-Run trailer is adopted instead of committed twice.
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { git, verify } from "./git-guard.mjs";

export const DEFAULT_PROTECTED = [".github/workflows/", ".gitmodules", ".claude/", ".codex/", ".mcp.json"];
const MAX_FILE_BYTES = 5 * 1024 * 1024;
// ponytail: a handful of well-known token shapes, not a secret scanner; upgrade to gitleaks if needed.
const SECRET_SHAPES = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk-ant-[A-Za-z0-9_-]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/, /\bAKIA[0-9A-Z]{16}\b/, /\bxox[baprs]-[A-Za-z0-9-]{10,}/, /\bsk-[A-Za-z0-9]{40,}/,
];
const IDENTITY = ["-c", "user.name=factory-broker", "-c", "user.email=factory-broker@localhost"];

const inside = (root, path) => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

function changedPaths(repo) {
  // Untrimmed on purpose: porcelain entries start with a status column that may be a space.
  const out = execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: repo, encoding: "utf8" });
  const paths = [];
  const items = out.split("\0").filter(Boolean);
  for (let i = 0; i < items.length; i += 1) {
    const status = items[i].slice(0, 2);
    paths.push(items[i].slice(3));
    if (status.startsWith("R") || status.startsWith("C")) i += 1;
  }
  return paths;
}

export function commitMessage(finalMessage, fallback) {
  const line = /^FACTORY_COMMIT:\s*(.+)$/m.exec(finalMessage ?? "")?.[1] ?? fallback;
  return line.replace(/[\r\n\t]/g, " ").trim().slice(0, 100) || fallback;
}

export function brokerCommit(repo, { branch, guardBefore, runId, message, protectedPaths = DEFAULT_PROTECTED }) {
  const guard = verify(repo, guardBefore, { branch });
  if (!guard.ok) return { ok: false, reason: `git guard: ${guard.violations.join("; ")}`, guard };
  if (guard.commits.length) {
    const [committer, ...body] = git(repo, ["log", "-1", "--format=%cn%n%B", guard.commits[0]]).split("\n");
    const own = guard.commits.length === 1 && committer === "factory-broker" && body.includes(`Factory-Run: ${runId}`);
    return own ? { ok: true, commit: guard.commits[0], adopted: true, files: [] } : { ok: false, reason: "the implementer created commits itself; only the Factory commits", guard };
  }
  const root = realpathSync(repo);
  const files = changedPaths(repo);
  if (!files.length) return { ok: true, commit: null, files };
  const refusals = [];
  for (const file of files) {
    if (file === ".git" || file.startsWith(".git/")) refusals.push(`${file}: git metadata`);
    if (protectedPaths.some((p) => (p.endsWith("/") ? file.startsWith(p) : file === p))) refusals.push(`${file}: protected path`);
    let stat;
    try { stat = lstatSync(join(repo, file)); } catch { continue; }
    if (stat.isSymbolicLink()) {
      let target = null;
      try { target = realpathSync(join(repo, file)); } catch { target = null; }
      if (target === null || !inside(root, target) || inside(join(root, ".git"), target)) refusals.push(`${file}: symlink leaves the workspace`);
    } else if (stat.size > MAX_FILE_BYTES) {
      refusals.push(`${file}: larger than ${MAX_FILE_BYTES} bytes`);
    } else if (stat.isFile() && SECRET_SHAPES.some((shape) => shape.test(readFileSync(join(repo, file), "utf8")))) {
      refusals.push(`${file}: looks like it contains a credential`);
    }
  }
  if (refusals.length) return { ok: false, reason: `commit refused: ${refusals.join("; ")}`, files };
  git(repo, ["add", "-A"]);
  git(repo, [...IDENTITY, "commit", "-q", "--no-verify", "-m", message, "-m", `Factory-Run: ${runId}`]);
  return { ok: true, commit: git(repo, ["rev-parse", "HEAD"]), adopted: false, files };
}

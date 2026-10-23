// Review inputs prepared by the Factory, never by the reviewed branch: an exact head SHA, the
// trusted diff against the fixed point, the ticket requirements read from that head, and a
// file snapshot the reviewer runs in. The snapshot is detached from the implementer workspace,
// stripped of agent-config files that a CLI would load as project settings, and made read-only
// with ordinary file permissions; its content hash is checked again after the review.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git-guard.mjs";

const AGENT_CONFIG = [".claude", ".mcp.json", ".codex", ".agents"];

function contentHash(dir) {
  const entries = [];
  const walk = (current, prefix) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) walk(path, `${prefix}${name}/`);
      else entries.push(`${prefix}${name}:${(stat.mode & 0o777).toString(8)}:${stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : "link"}`);
    }
  };
  walk(dir, "");
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

const setWritable = (dir, writable) => {
  const walk = (path) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      if (writable) chmodSync(path, 0o755);
      for (const name of readdirSync(path)) walk(join(path, name));
    }
    chmodSync(path, writable ? (stat.isDirectory() ? 0o755 : 0o644) : stat.mode & 0o555);
  };
  walk(dir);
};

export function prepareSnapshot(repo, { base, head, issue, root }) {
  const dir = join(root, head.slice(0, 12));
  const metaFile = join(dir, "meta.json");
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    if (meta.head === head && meta.base === base) return meta;
    setWritable(dir, true);
    rmSync(dir, { recursive: true, force: true });
  }
  mkdirSync(join(dir, "src"), { recursive: true });
  execFileSync("/bin/sh", ["-c", 'git -c core.hooksPath=/dev/null archive --format=tar "$1" | tar -x -C "$2"', "sh", head, join(dir, "src")], { cwd: repo });
  const stripped = AGENT_CONFIG.filter((name) => existsSync(join(dir, "src", name)));
  for (const name of stripped) rmSync(join(dir, "src", name), { recursive: true, force: true });
  const diff = git(repo, ["diff", "--no-ext-diff", "--no-color", `${base}...${head}`]);
  let requirements = null;
  try { requirements = git(repo, ["show", `${head}:${issue}`]); } catch { requirements = null; }
  writeFileSync(join(dir, "diff.patch"), `${diff}\n`);
  writeFileSync(join(dir, "requirements.md"), `${requirements ?? `(issue file ${issue} not found at ${head})`}\n`);
  setWritable(join(dir, "src"), false);
  const meta = { schema: "factory.review-snapshot.v1", head, base, issue, dir, src: join(dir, "src"), stripped, diffBytes: Buffer.byteLength(diff), hash: contentHash(join(dir, "src")) };
  writeFileSync(metaFile, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function checkSnapshot(meta) {
  const hash = contentHash(meta.src);
  return { unchanged: hash === meta.hash, hash };
}

export function snapshotBrief(meta) {
  return [
    `Review target: head ${meta.head} against fixed point ${meta.base}. Your working directory is a read-only snapshot of that head.`,
    "The Factory computed the diff below from git; treat it as the authoritative change set. The requirements come from the ticket's issue file at that head.",
    "", "<<<REQUIREMENTS", readFileSync(join(meta.dir, "requirements.md"), "utf8").trimEnd(), "REQUIREMENTS>>>",
    "", "<<<DIFF", readFileSync(join(meta.dir, "diff.patch"), "utf8").trimEnd(), "DIFF>>>",
  ].join("\n");
}

// debate-review fetches the PR head itself and reviews it in its own detached worktree, so it only
// needs a clone that is not the implementer's workspace and whose origin names the PR repository.
export function reviewClone(repo, { root, remoteUrl }) {
  const dir = join(root, "clone");
  if (!existsSync(join(dir, ".git"))) {
    mkdirSync(root, { recursive: true });
    execFileSync("git", ["-c", "core.hooksPath=/dev/null", "clone", "--quiet", "--no-hardlinks", "--no-checkout", repo, dir]);
  }
  git(dir, ["remote", "set-url", "origin", remoteUrl]);
  return dir;
}

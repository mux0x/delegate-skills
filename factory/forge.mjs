// Factory-owned forge side effects through the official `gh` CLI, always pinned to one repo.
// There is deliberately no merge operation: the final merge stays with a human.
import { execFileSync } from "node:child_process";

export function makeForge({ gh = "gh", repo, env = process.env }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || "")) throw new Error("forge needs repo as owner/name");
  const run = (args, input) => execFileSync(gh, [...args, "--repo", repo], {
    encoding: "utf8", env, input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], timeout: 60_000,
  }).trim();
  const view = (number) => JSON.parse(run(["pr", "view", String(number), "--json", "number,state,isDraft,headRefOid,headRefName,baseRefName,url,mergedAt,mergeCommit"]));
  return {
    repo,
    findPr(head) {
      const list = JSON.parse(run(["pr", "list", "--head", head, "--state", "all", "--json", "number,state,isDraft,headRefOid,headRefName,url"]));
      return list.find((pr) => pr.headRefName === head) ?? null;
    },
    createDraftPr({ head, base, title, body }) {
      run(["pr", "create", "--draft", "--head", head, "--base", base, "--title", title, "--body-file", "-"], body);
      return this.findPr(head);
    },
    view,
    markReady(number) { run(["pr", "ready", String(number)]); return view(number); },
    comment(number, body) { run(["pr", "comment", String(number), "--body-file", "-"], body); },
  };
}

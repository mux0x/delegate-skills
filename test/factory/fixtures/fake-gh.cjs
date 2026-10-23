#!/usr/bin/env node
// Fake `gh` for the mini-Factory simulation: PR state lives in FAKE_GH_STATE, head SHAs come
// from the local bare remote in FAKE_GH_REMOTE, and every call is logged so tests can prove
// that no merge was ever attempted.
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const args = process.argv.slice(2);
const stateFile = process.env.FAKE_GH_STATE;
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : { prs: [], calls: [] };
state.calls.push(args.filter((a, i) => args[i - 1] !== "--repo" && a !== "--repo"));
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
const opt = (flag) => args[args.indexOf(flag) + 1];
const headSha = (branch) => {
  try { return execFileSync("git", ["--git-dir", process.env.FAKE_GH_REMOTE, "rev-parse", `refs/heads/${branch}`], { encoding: "utf8" }).trim(); } catch { return null; }
};
const shape = (pr) => ({ ...pr, headRefOid: headSha(pr.headRefName) });

if (args[0] !== "pr") { save(); console.error(`fake gh: unsupported ${args[0]}`); process.exit(1); }
const sub = args[1];
if (sub === "list") {
  save();
  console.log(JSON.stringify(state.prs.filter((pr) => pr.headRefName === opt("--head")).map(shape)));
} else if (sub === "create") {
  const head = opt("--head");
  if (state.prs.some((pr) => pr.headRefName === head && pr.state === "OPEN")) { save(); console.error("a pull request already exists"); process.exit(1); }
  const number = state.prs.length + 1;
  state.prs.push({ number, headRefName: head, baseRefName: opt("--base"), title: opt("--title"), body: fs.readFileSync(0, "utf8"), state: "OPEN", isDraft: args.includes("--draft"), url: `https://example.invalid/pr/${number}`, mergedAt: null });
  save();
  console.log(`https://example.invalid/pr/${number}`);
} else if (sub === "view") {
  const pr = state.prs.find((p) => p.number === Number(args[2]));
  save();
  if (!pr) process.exit(1);
  console.log(JSON.stringify(shape(pr)));
} else if (sub === "ready") {
  state.prs.find((p) => p.number === Number(args[2])).isDraft = false;
  save();
} else if (sub === "comment") {
  save();
} else {
  save();
  console.error(`fake gh: refusing pr ${sub}`);
  process.exit(1);
}

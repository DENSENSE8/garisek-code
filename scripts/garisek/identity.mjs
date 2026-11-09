#!/usr/bin/env node
// Input identity for Garisek receipts (parent check ID1). HEAD alone is not identity:
// working-tree digests cover tracked edits and untracked files.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const home = NodeOS.homedir();
const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const run = (cmd, args, cwd) => {
  try {
    return NodeChildProcess.execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1 << 30,
    }).trim();
  } catch {
    return null;
  }
};

function repoIdentity(root) {
  if (!NodeFS.existsSync(NodePath.join(root, ".git"))) return { root, present: false };
  const head = run("git", ["rev-parse", "HEAD"], root);
  const diff = run("git", ["diff", "HEAD", "--binary"], root) ?? "";
  const untracked = (run("git", ["ls-files", "--others", "--exclude-standard", "-z"], root) ?? "")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedHash = NodeCrypto.createHash("sha256");
  for (const file of untracked) {
    const abs = NodePath.join(root, file);
    const st = NodeFS.statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    untrackedHash.update(file).update("\0").update(NodeFS.readFileSync(abs)).update("\0");
  }
  const treeDigest = sha256(`${head}\n${sha256(diff)}\n${untrackedHash.digest("hex")}`);
  return {
    root,
    present: true,
    head,
    dirty: diff.length > 0 || untracked.length > 0,
    untrackedCount: untracked.length,
    treeDigest,
  };
}

function fileDigest(file) {
  const real = NodeFS.realpathSync(file);
  return { path: file, realPath: real, sha256: sha256(NodeFS.readFileSync(real)) };
}

function ompIdentity() {
  const dir = NodePath.join(home, ".omp/agent/extensions");
  const extensions = NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir)
        .filter((name) => /\.(ts|js|mjs)$/.test(name))
        .sort()
        .flatMap((name) => {
          try {
            return [fileDigest(NodePath.join(dir, name))];
          } catch {
            return [{ path: NodePath.join(dir, name), missing: true }];
          }
        })
    : [];
  const bin = run("sh", ["-c", "command -v omp"]);
  return { version: run("omp", ["--version"]), binary: bin ? fileDigest(bin) : null, extensions };
}

function artifacts(paths) {
  return paths.filter((p) => NodeFS.existsSync(p)).map(fileDigest);
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repos = (
  opt("--repos", "") ||
  [
    NodePath.join(home, "Projects/garisek-code"),
    NodePath.join(home, "Projects/cycleforge-app"),
  ].join(",")
)
  .split(",")
  .filter(Boolean);
const artifactPaths = (opt("--artifacts", "") || "").split(",").filter(Boolean);

const identity = {
  schema: "garisek.identity/1",
  createdAt: new Date().toISOString(),
  host: NodeOS.hostname(),
  // oxlint-disable-next-line t3code/no-global-process-runtime -- standalone CLI, not Effect code
  platform: `${NodeOS.platform()}-${NodeOS.arch()}`,
  node: process.version,
  repos: repos.map(repoIdentity),
  omp: ompIdentity(),
  artifacts: artifacts(artifactPaths),
};
const stable = { ...identity, createdAt: undefined };
identity.digest = sha256(JSON.stringify(stable));

const out = opt("--out", null);
const text = `${JSON.stringify(identity, null, 1)}\n`;
if (out) NodeFS.writeFileSync(out, text);
process.stdout.write(out ? `${identity.digest} ${out}\n` : text);

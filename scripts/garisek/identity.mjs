#!/usr/bin/env node
// Input identity for Garisek receipts (parent check ID1). HEAD alone is not identity:
// working-tree digests cover tracked edits and untracked files.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import path from "node:path";

const home = homedir();
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const run = (cmd, args, cwd) => {
  try {
    return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 30 }).trim();
  } catch {
    return null;
  }
};

function repoIdentity(root) {
  if (!existsSync(path.join(root, ".git"))) return { root, present: false };
  const head = run("git", ["rev-parse", "HEAD"], root);
  const diff = run("git", ["diff", "HEAD", "--binary"], root) ?? "";
  const untracked = (run("git", ["ls-files", "--others", "--exclude-standard", "-z"], root) ?? "")
    .split("\0")
    .filter(Boolean)
    .sort();
  const untrackedHash = createHash("sha256");
  for (const file of untracked) {
    const abs = path.join(root, file);
    const st = statSync(abs, { throwIfNoEntry: false });
    if (!st?.isFile()) continue;
    untrackedHash.update(file).update("\0").update(readFileSync(abs)).update("\0");
  }
  const treeDigest = sha256(`${head}\n${sha256(diff)}\n${untrackedHash.digest("hex")}`);
  return { root, present: true, head, dirty: diff.length > 0 || untracked.length > 0, untrackedCount: untracked.length, treeDigest };
}

function fileDigest(file) {
  const real = realpathSync(file);
  return { path: file, realPath: real, sha256: sha256(readFileSync(real)) };
}

function ompIdentity() {
  const dir = path.join(home, ".omp/agent/extensions");
  const extensions = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => /\.(ts|js|mjs)$/.test(name))
        .sort()
        .flatMap((name) => {
          try {
            return [fileDigest(path.join(dir, name))];
          } catch {
            return [{ path: path.join(dir, name), missing: true }];
          }
        })
    : [];
  const bin = run("sh", ["-c", "command -v omp"]);
  return { version: run("omp", ["--version"]), binary: bin ? fileDigest(bin) : null, extensions };
}

function artifacts(paths) {
  return paths.filter((p) => existsSync(p)).map(fileDigest);
}

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const repos = (opt("--repos", "") || [
  path.join(home, "Projects/garisek-code"),
  path.join(home, "Projects/cycleforge-app"),
].join(",")).split(",").filter(Boolean);
const artifactPaths = (opt("--artifacts", "") || "").split(",").filter(Boolean);

const identity = {
  schema: "garisek.identity/1",
  createdAt: new Date().toISOString(),
  host: hostname(),
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  repos: repos.map(repoIdentity),
  omp: ompIdentity(),
  artifacts: artifacts(artifactPaths),
};
const stable = { ...identity, createdAt: undefined };
identity.digest = sha256(JSON.stringify(stable));

const out = opt("--out", null);
const text = `${JSON.stringify(identity, null, 1)}\n`;
if (out) writeFileSync(out, text);
process.stdout.write(out ? `${identity.digest} ${out}\n` : text);

#!/usr/bin/env node
// Tamper-evident receipt ledger (check SG2). `seal` chains each receipt's content hash into
// <root>/LEDGER.jsonl and makes the receipt read-only; `verify` recomputes the chain and every live
// receipt. Receipts are superseded by new files, never rewritten. Any prefix of the ledger is itself
// a valid chain, so keep the printed head as an external checkpoint for `verify --expect-head`.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const fail = (message) => {
  console.error(message);
  process.exit(1);
};
const [command, ...rest] = process.argv.slice(2);
const options = { files: [] };
for (let index = 0; index < rest.length; index += 1) {
  if (rest[index] === "--root") options.root = rest[++index];
  else if (rest[index] === "--supersedes") options.supersedes = rest[++index];
  else if (rest[index] === "--expect-head") options.expectHead = rest[++index];
  else options.files.push(rest[index]);
}
if (!["seal", "verify"].includes(command) || !options.root) {
  console.error(
    "usage: receipts.mjs seal --root <dir> <file...> [--supersedes <file>]\n       receipts.mjs verify --root <dir> [--expect-head <entryHash>]",
  );
  process.exit(2);
}
const root = NodePath.resolve(options.root);
const ledgerPath = NodePath.join(root, "LEDGER.jsonl");
const sha256 = (data) => NodeCrypto.createHash("sha256").update(data).digest("hex");
const GENESIS = "0".repeat(64);

const readLedger = () =>
  NodeFS.existsSync(ledgerPath)
    ? NodeFS.readFileSync(ledgerPath, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const entryHash = ({ entryHash: _omit, ...entry }) => sha256(JSON.stringify(entry));
const relative = (file) => {
  const rel = NodePath.relative(root, NodePath.resolve(file));
  if (rel.startsWith("..") || NodePath.isAbsolute(rel)) fail(`${file} is outside ${root}`);
  return rel;
};
const latestByPath = (ledger) => new Map(ledger.map((entry) => [entry.path, entry]));

if (command === "seal") {
  const ledger = readLedger();
  const latest = latestByPath(ledger);
  const supersedes = options.supersedes ? relative(options.supersedes) : null;
  if (supersedes && !latest.has(supersedes)) fail(`${supersedes} was never sealed`);
  for (const file of options.files) {
    const path = relative(file);
    const digest = sha256(NodeFS.readFileSync(NodePath.join(root, path)));
    const previous = latest.get(path);
    if (previous?.sha256 === digest) {
      console.log(`already sealed ${path} head ${ledger.at(-1).entryHash}`);
      continue;
    }
    if (previous)
      fail(`${path} was sealed as ${previous.sha256.slice(0, 12)}; write a new receipt instead`);
    const entry = {
      seq: ledger.length,
      path,
      sha256: digest,
      sealedAt: new Date().toISOString(),
      supersedes,
      prevHash: ledger.at(-1)?.entryHash ?? GENESIS,
    };
    entry.entryHash = entryHash(entry);
    NodeFS.appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
    ledger.push(entry);
    latest.set(path, entry);
    NodeFS.chmodSync(NodePath.join(root, path), 0o444);
    console.log(`sealed #${entry.seq} ${path} ${digest.slice(0, 12)} head ${entry.entryHash}`);
  }
} else {
  const ledger = readLedger();
  const problems = [];
  ledger.forEach((entry, index) => {
    const expectedPrev = index === 0 ? GENESIS : ledger[index - 1].entryHash;
    if (entry.seq !== index) problems.push(`#${index}: seq ${entry.seq} out of order`);
    if (entry.prevHash !== expectedPrev) problems.push(`#${index}: chain broken (prevHash)`);
    if (entry.entryHash !== entryHash(entry)) problems.push(`#${index}: entry edited (entryHash)`);
  });
  const head = ledger.at(-1)?.entryHash ?? GENESIS;
  if (options.expectHead && head !== options.expectHead)
    problems.push(
      `ledger head ${head.slice(0, 12)} is not the recorded checkpoint ${options.expectHead.slice(0, 12)} (truncated, replaced, or checkpoint not updated after a seal)`,
    );
  for (const entry of latestByPath(ledger).values()) {
    const file = NodePath.join(root, entry.path);
    if (!NodeFS.existsSync(file)) problems.push(`${entry.path}: missing`);
    else if (sha256(NodeFS.readFileSync(file)) !== entry.sha256)
      problems.push(`${entry.path}: content differs from sealed #${entry.seq}`);
  }
  console.log(
    JSON.stringify({
      entries: ledger.length,
      receipts: latestByPath(ledger).size,
      superseded: [...new Set(ledger.map((entry) => entry.supersedes).filter(Boolean))],
      head,
      headAnchored: Boolean(options.expectHead),
      problems,
    }),
  );
  process.exit(problems.length ? 1 : 0);
}

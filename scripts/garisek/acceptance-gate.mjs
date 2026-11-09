#!/usr/bin/env node
// Parent acceptance gate (check GATE1). Exit 0 only when every requirement's checks are PASS
// with existing, unmodified evidence bound to the current input identity and judged by
// someone other than the builder session. Everything else is reported and exits 1.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const manifestPath = opt("--manifest");
if (!manifestPath) {
  console.error(
    "usage: acceptance-gate.mjs --manifest <acceptance-manifest.json> [--identity <identity.json>] [--metric Mxx] [--check-identity] [--json]",
  );
  process.exit(2);
}
const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8"));
const baseDir = NodePath.dirname(NodePath.dirname(NodePath.resolve(manifestPath)));

const expected = [
  ...Array.from({ length: 14 }, (_, i) => `A${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 12 }, (_, i) => `S${String(i + 1).padStart(2, "0")}`),
  ...Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, "0")}`),
];

const currentIdentity = (() => {
  const file = opt("--identity");
  if (file) return JSON.parse(NodeFS.readFileSync(file, "utf8"));
  const script = NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "identity.mjs",
  );
  return JSON.parse(
    NodeChildProcess.execFileSync(process.execPath, [script], {
      encoding: "utf8",
      maxBuffer: 1 << 28,
    }),
  );
})();

const problems = [];
const reqIds = Object.keys(manifest.requirements ?? {}).sort();
const missingReqs = expected.filter((id) => !reqIds.includes(id));
const extraReqs = reqIds.filter((id) => !expected.includes(id));
if (missingReqs.length) problems.push(`requirement IDs missing: ${missingReqs.join(",")}`);
if (extraReqs.length) problems.push(`unexpected requirement IDs: ${extraReqs.join(",")}`);

const checks = new Map((manifest.checks ?? []).map((c) => [c.id, c]));
for (const id of expected) {
  const linked = manifest.requirements?.[id]?.checks ?? [];
  if (!linked.length) problems.push(`${id} has no linked check`);
  for (const c of linked) if (!checks.has(c)) problems.push(`${id} links unknown check ${c}`);
}

function judge(check) {
  if (check.status !== "PASS") return check.status ?? "NOT_RUN";
  const evidence = check.evidence ?? [];
  if (!evidence.length) return "NO_EVIDENCE";
  for (const e of evidence) {
    const file = NodePath.isAbsolute(e.path) ? e.path : NodePath.join(baseDir, e.path);
    if (!NodeFS.existsSync(file)) return "EVIDENCE_MISSING";
    if (
      NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex") !== e.sha256
    )
      return "EVIDENCE_MODIFIED";
    if (e.identityDigest !== currentIdentity.digest) return "STALE";
    const by = e.verifiedBy ?? {};
    if (check.id === "H1") {
      if (by.kind !== "human") return "PENDING_HUMAN";
    } else if (
      by.kind !== "independent-verifier" ||
      !by.session ||
      by.session === manifest.session
    ) {
      return "SELF_REPORTED";
    }
  }
  return "PASS";
}

const metric = opt("--metric");
const selected = [...checks.values()].filter((c) => !metric || (c.links ?? []).includes(metric));
const rows = selected.map((c) => ({
  id: c.id,
  links: (c.links ?? []).join(","),
  verdict:
    args.includes("--check-identity") && c.status !== "PASS"
      ? `${c.status} (identity n/a)`
      : judge(c),
}));

if (args.includes("--json")) {
  console.log(JSON.stringify({ identity: currentIdentity.digest, problems, rows }, null, 1));
} else {
  console.log(`identity ${currentIdentity.digest}  manifest ${manifest.contractVersion}`);
  for (const r of rows) console.log(`${r.verdict.padEnd(18)} ${r.id.padEnd(7)} ${r.links}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  const counts = rows.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] ?? 0) + 1), m), {});
  console.log(
    Object.entries(counts)
      .map(([k, v]) => `${k}=${v}`)
      .join(" "),
  );
}
const ok = !problems.length && rows.length > 0 && rows.every((r) => r.verdict === "PASS");
process.exit(ok ? 0 : 1);

#!/usr/bin/env node
// garisek.inventory/1: independent first-party inventory denominator (check INV1).
// Usage: node inventory.mjs --repo <root> --name <id> --out <file>. The extractor contract,
// exclusions and rerun commands are in ~/agent-reviews/progress/Garisek-OS-01a1b86b-a075/inventory/FREEZE.md.

import { createHash } from "crypto";
import { readFileSync, existsSync, statSync } from "fs";
import { execSync } from "child_process";
import { join, relative, extname, dirname, basename } from "path";
import { createRequire } from "module";

// ── CLI ────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function getArg(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const repoRoot = getArg("--repo");
const repoId = getArg("--name");
const outFile = getArg("--out");

if (!repoRoot || !repoId || !outFile) {
  console.error("Usage: node inventory.mjs --repo <root> --name <id> --out <file>");
  process.exit(1);
}

// ── TypeScript loader ─────────────────────────────────────────────────────────

function loadTs(root) {
  // Try project-local typescript first, then fallback locations
  const candidates = [
    join(root, "node_modules", "typescript"),
    join(root, "..", "Garisek-OS", "node_modules", "typescript"),
    join(root, "..", "garisek-code", "node_modules", "typescript"),
    "/home/michaelgarisek/Projects/Garisek-OS/node_modules/typescript",
    "/home/michaelgarisek/Projects/cycleforge-app/node_modules/typescript",
  ];
  for (const p of candidates) {
    const pkg = join(p, "package.json");
    if (existsSync(pkg)) {
      const req = createRequire(import.meta.url);
      try {
        return req(join(p, "lib", "typescript.js"));
      } catch {}
    }
  }
  return null;
}

const ts = loadTs(repoRoot);
if (!ts) {
  console.error("WARN: TypeScript not found; symbols will be regex-extracted");
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256File(absPath) {
  try {
    const buf = readFileSync(absPath);
    return createHash("sha256").update(buf).digest("hex");
  } catch {
    return null;
  }
}

function sha256String(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function stableId(kind, path, name) {
  if (name) return `${repoId}:${kind}:${path}#${name}`;
  return `${repoId}:${kind}:${path}`;
}

function readJson(absPath) {
  try {
    return JSON.parse(readFileSync(absPath, "utf8"));
  } catch {
    return null;
  }
}

function readText(absPath) {
  try {
    return readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
}

// ── Git ls-files ──────────────────────────────────────────────────────────────

function gitLsFiles(root) {
  const out = execSync("git ls-files -z", { cwd: root, maxBuffer: 64 * 1024 * 1024 }).toString(
    "utf8",
  );
  return out.split("\0").filter(Boolean);
}

// ── Exclusion rules ───────────────────────────────────────────────────────────

const EXCLUSIONS = [
  {
    pattern: /^node_modules\//,
    reason: "Third-party package tree",
    category: "third-party",
  },
  {
    pattern: /^\.next\//,
    reason: "Next.js build cache/output — not first-party source",
    category: "build-output",
  },
  {
    pattern: /^dist\//,
    reason: "Compiled distribution output",
    category: "build-output",
  },
  {
    pattern: /^target\//,
    reason: "Rust/cargo build output",
    category: "build-output",
  },
  {
    pattern: /^(android|ios)\/build\//,
    reason: "Native platform build output",
    category: "build-output",
  },
  {
    pattern: /^android\/(gradle\/|gradlew(\.bat)?$)/,
    reason: "Android Gradle wrapper — build toolchain, not first-party source",
    category: "build-toolchain",
  },
  {
    pattern: /\.tsbuildinfo$/,
    reason: "TypeScript incremental compilation cache — derived artifact",
    category: "build-output",
  },
  {
    pattern: /^(pnpm-lock\.yaml|package-lock\.json|yarn\.lock|Cargo\.lock)$/,
    reason: "Dependency lock file — package metadata, not source code",
    category: "package-metadata",
  },
];

function getExclusion(relPath) {
  for (const rule of EXCLUSIONS) {
    if (rule.pattern.test(relPath)) return rule;
  }
  return null;
}

// ── Language classifier ───────────────────────────────────────────────────────

const LANG_MAP = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".rs": "rust",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".py": "python",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".sh": "shell",
  ".bash": "shell",
  ".sql": "sql",
  ".json": "json",
  ".jsonl": "jsonl",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "mdx",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".tf": "terraform",
};

const EXTRACTABLE = new Set(["typescript", "tsx", "javascript", "jsx"]);

function classifyLang(relPath) {
  const ext = extname(relPath).toLowerCase();
  return LANG_MAP[ext] || "other";
}

// ── TypeScript AST symbol extractor ──────────────────────────────────────────

// Top-level declarations only (direct SourceFile children); TSX/JSX functions or consts with an
// uppercase name that return JSX count as components, exported ones as reusable.
function extractSymbolsTs(absPath, relPath, lang) {
  const symbols = [];
  const components = [];

  const text = readText(absPath);
  if (text === null) return { symbols, components };

  const isTsx = lang === "tsx" || lang === "jsx";

  if (ts) {
    // TypeScript AST extraction
    const sf = ts.createSourceFile(
      relPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.Unknown,
    );

    for (const stmt of sf.statements) {
      extractFromStatement(stmt, text, relPath, lang, symbols, components);
    }
  } else {
    // Regex fallback when TypeScript isn't available
    extractSymbolsRegex(text, relPath, lang, symbols, components);
  }

  return { symbols, components };
}

function extractFromStatement(stmt, text, relPath, lang, symbols, components) {
  const isTsx = lang === "tsx" || lang === "jsx";

  // Exported declaration
  const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  const isDefaultExport =
    stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

  // export default expression (e.g. export default function Page() {})
  if (stmt.kind === ts.SyntaxKind.ExportAssignment) {
    // export default <expr> — record as anonymous default if no name
    symbols.push({
      id: stableId("symbol", relPath, "default"),
      name: "default",
      kind: "export-default",
      exported: true,
    });
    return;
  }

  // function declaration
  if (stmt.kind === ts.SyntaxKind.FunctionDeclaration) {
    const name = stmt.name?.text;
    if (!name && !isExported) return;
    const symName = name || "default";
    if (!name && !isDefaultExport) return;

    symbols.push({
      id: stableId("symbol", relPath, symName),
      name: symName,
      kind: "function",
      exported: isExported || isDefaultExport,
    });

    if (
      isTsx &&
      symName[0] === symName[0].toUpperCase() &&
      symName[0] !== symName[0].toLowerCase()
    ) {
      // Heuristic: uppercase function in TSX is likely a React component
      const hasJsx = nodeContainsJsx(stmt, ts);
      if (hasJsx) {
        components.push({
          id: stableId("component", relPath, symName),
          name: symName,
          path: relPath,
          exported: isExported || isDefaultExport,
          reusable: isExported || isDefaultExport,
        });
      }
    }
    return;
  }

  // class declaration
  if (stmt.kind === ts.SyntaxKind.ClassDeclaration) {
    const name = stmt.name?.text || "default";
    if (!isExported && !isDefaultExport && !name) return;
    symbols.push({
      id: stableId("symbol", relPath, name),
      name,
      kind: "class",
      exported: isExported || isDefaultExport,
    });
    return;
  }

  // variable statement (const/let/var)
  if (stmt.kind === ts.SyntaxKind.VariableStatement) {
    const isTopExported = isExported;
    const decls = stmt.declarationList?.declarations || [];
    for (const decl of decls) {
      const name = getBindingName(decl.name);
      if (!name) continue;

      symbols.push({
        id: stableId("symbol", relPath, name),
        name,
        kind: "const",
        exported: isTopExported,
      });

      // Check if it's a React component (arrow function, uppercase, JSX)
      if (isTsx && name[0] >= "A" && name[0] <= "Z") {
        const init = decl.initializer;
        if (
          init &&
          (init.kind === ts.SyntaxKind.ArrowFunction ||
            init.kind === ts.SyntaxKind.FunctionExpression)
        ) {
          const hasJsx = nodeContainsJsx(init, ts);
          if (hasJsx) {
            components.push({
              id: stableId("component", relPath, name),
              name,
              path: relPath,
              exported: isTopExported,
              reusable: isTopExported,
            });
          }
        }
      }
    }
    return;
  }

  // type alias
  if (stmt.kind === ts.SyntaxKind.TypeAliasDeclaration) {
    const name = stmt.name?.text;
    if (!name) return;
    if (!isExported) return; // only record exported types
    symbols.push({
      id: stableId("symbol", relPath, name),
      name,
      kind: "type",
      exported: true,
    });
    return;
  }

  // interface
  if (stmt.kind === ts.SyntaxKind.InterfaceDeclaration) {
    const name = stmt.name?.text;
    if (!name) return;
    if (!isExported) return;
    symbols.push({
      id: stableId("symbol", relPath, name),
      name,
      kind: "interface",
      exported: true,
    });
    return;
  }

  // enum
  if (stmt.kind === ts.SyntaxKind.EnumDeclaration) {
    const name = stmt.name?.text;
    if (!name) return;
    if (!isExported) return;
    symbols.push({
      id: stableId("symbol", relPath, name),
      name,
      kind: "enum",
      exported: true,
    });
    return;
  }

  // export { ... } re-exports
  if (stmt.kind === ts.SyntaxKind.ExportDeclaration) {
    const clause = stmt.exportClause;
    if (clause && clause.kind === ts.SyntaxKind.NamedExports) {
      for (const el of clause.elements || []) {
        const name = el.name?.text;
        if (name) {
          symbols.push({
            id: stableId("symbol", relPath, name),
            name,
            kind: "re-export",
            exported: true,
          });
        }
      }
    }
    return;
  }
}

function getBindingName(node) {
  if (!node) return null;
  if (node.kind === ts.SyntaxKind.Identifier) return node.text;
  // Destructuring patterns — skip for now (too complex for stable IDs)
  return null;
}

function nodeContainsJsx(node, tsApi) {
  // Walk the AST to find JSX elements
  let found = false;
  function visit(n) {
    if (found) return;
    if (
      n.kind === tsApi.SyntaxKind.JsxElement ||
      n.kind === tsApi.SyntaxKind.JsxSelfClosingElement ||
      n.kind === tsApi.SyntaxKind.JsxFragment
    ) {
      found = true;
      return;
    }
    tsApi.forEachChild(n, visit);
  }
  visit(node);
  return found;
}

function extractSymbolsRegex(text, relPath, lang, symbols, components) {
  // Fallback regex extractor when TypeScript is unavailable
  const isTsx = lang === "tsx" || lang === "jsx";

  // Export patterns
  const exportFn = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
  const exportClass = /^export\s+class\s+(\w+)/gm;
  const exportConst = /^export\s+(?:const|let|var)\s+(\w+)/gm;
  const exportType = /^export\s+type\s+(\w+)/gm;
  const exportIface = /^export\s+interface\s+(\w+)/gm;
  const exportEnum = /^export\s+enum\s+(\w+)/gm;
  const exportDefault = /^export\s+default\s+(?:function\s+(\w+)|class\s+(\w+)|(\w+))/gm;

  for (const [pattern, kind] of [
    [exportFn, "function"],
    [exportClass, "class"],
    [exportConst, "const"],
    [exportType, "type"],
    [exportIface, "interface"],
    [exportEnum, "enum"],
  ]) {
    let m;
    while ((m = pattern.exec(text)) !== null) {
      const name = m[1];
      symbols.push({ id: stableId("symbol", relPath, name), name, kind, exported: true });
      if (isTsx && name[0] >= "A" && name[0] <= "Z") {
        components.push({
          id: stableId("component", relPath, name),
          name,
          path: relPath,
          exported: true,
          reusable: true,
        });
      }
    }
  }

  let m;
  while ((m = exportDefault.exec(text)) !== null) {
    const name = m[1] || m[2] || m[3] || "default";
    symbols.push({
      id: stableId("symbol", relPath, name),
      name,
      kind: "export-default",
      exported: true,
    });
  }
}

// ── Next.js App Router route extractor ───────────────────────────────────────

// Next.js app router: page = screen, layout = layout, route = API handler.
// Dynamic segments: [param] → :param, [...param] → *param, [[...param]] → ?*param
function extractRoutes(root, repoRelRoot) {
  const appDir = join(root, repoRelRoot);
  if (!existsSync(appDir)) return [];

  const routes = [];
  walkAppDir(appDir, appDir, "", routes);
  return routes;
}

function walkAppDir(appRoot, dir, segment, routes) {
  let entries;
  try {
    entries = execSync(`ls -1 "${dir}"`, { maxBuffer: 4 * 1024 * 1024 })
      .toString()
      .trim()
      .split("\n")
      .filter(Boolean);
  } catch {
    return;
  }

  for (const entry of entries) {
    const abs = join(dir, entry);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }

    if (stat.isDirectory()) {
      // Skip non-route dirs
      if (entry === "_components" || entry === "_lib" || entry.startsWith("_")) {
        // underscore dirs are private and not routes
        const subSegment = segment; // don't add to path
        walkAppDir(appRoot, abs, subSegment, routes);
        continue;
      }
      const seg = normalizeDirSegment(entry);
      const newSegment = segment + "/" + seg;
      walkAppDir(appRoot, abs, newSegment, routes);
    } else if (stat.isFile()) {
      if (/^(page|layout|template)\.(tsx?|jsx?)$/.test(entry)) {
        const kind = entry.startsWith("page")
          ? "page"
          : entry.startsWith("layout")
            ? "layout"
            : "template";
        const routePath = segment || "/";
        const relPath = relative(join(appRoot, "..", ".."), abs);

        routes.push({
          id: stableId("route", relPath, routePath),
          path: routePath,
          kind,
          file: relPath,
          dynamic: routePath.includes(":") || routePath.includes("*"),
        });
      } else if (/^route\.(tsx?|jsx?)$/.test(entry)) {
        const routePath = segment || "/";
        const relPath = relative(join(appRoot, "..", ".."), abs);
        routes.push({
          id: stableId("route", relPath, routePath),
          path: routePath,
          kind: "api-handler",
          file: relPath,
          dynamic: routePath.includes(":") || routePath.includes("*"),
        });
      }
    }
  }
}

function normalizeDirSegment(dir) {
  // Next.js dynamic segments
  if (/^\[\[\.\.\.(\w+)\]\]$/.test(dir)) return `?*${dir.match(/\w+/)[0]}`; // optional catch-all
  if (/^\[\.\.\.(\w+)\]$/.test(dir)) return `*${dir.match(/\w+/)[0]}`; // catch-all
  if (/^\[(\w+)\]$/.test(dir)) return `:${dir.match(/\w+/)[0]}`; // dynamic
  if (/^\(.*\)$/.test(dir)) return `(${dir.slice(1, -1)})`; // route group — stays in segment but not in URL
  return dir;
}

// ── Feature record extractor ──────────────────────────────────────────────────

function extractFeatures(root) {
  // Try known locations for feature records
  const candidatePaths = [
    "docs/atlas/features.json",
    "tools/feature-atlas/features.json",
    ".claude/skills/verify/features", // directory
  ];

  for (const p of candidatePaths) {
    const abs = join(root, p);
    if (!existsSync(abs)) continue;

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }

    if (stat.isFile() && p.endsWith(".json")) {
      const data = readJson(abs);
      if (!data) continue;

      const feats = data.features || data;
      if (typeof feats === "object" && !Array.isArray(feats)) {
        return Object.entries(feats).map(([id, feat]) => ({
          id: stableId("feature", p, id),
          featureId: id,
          file: p,
          routes: feat.routes?.map((r) => r.pattern || r.id) || [],
          hasDriver: !!(feat.driver || feat.skill),
          purpose: feat.purpose?.slice(0, 120) || null,
        }));
      }
      if (Array.isArray(feats)) {
        return feats.map((feat, i) => ({
          id: stableId("feature", p, feat.id || String(i)),
          featureId: feat.id || String(i),
          file: p,
          routes: feat.routes || [],
          hasDriver: !!(feat.driver || feat.skill),
          purpose: feat.purpose?.slice(0, 120) || null,
        }));
      }
    }
  }

  return null; // extractor: "missing"
}

// ── Laws / bindings extractor ─────────────────────────────────────────────────

function extractLaws(root) {
  // Try docs/laws/laws.map.json (cycleforge style)
  const lmPath = join(root, "docs/laws/laws.map.json");
  if (existsSync(lmPath)) {
    const data = readJson(lmPath);
    if (data) {
      const laws = data.laws || {};
      const links = data.links || [];

      const lawRecords = Object.entries(laws).map(([id, law]) => ({
        id: stableId("law", "docs/laws/laws.map.json", id),
        lawId: id,
        file: law.file || null,
        summary: law.summary?.slice(0, 120) || null,
      }));

      const bindingRecords = links.map((link, i) => {
        const lawIds = link.laws || [];
        const paths = link.paths || [];
        return {
          id: stableId("law", "docs/laws/laws.map.json", `binding-${i}`),
          lawIds,
          paths,
          kind: "binding",
        };
      });

      return { laws: lawRecords, bindings: bindingRecords };
    }
  }

  // Try docs/laws/repo-law.json (Garisek-OS style, map points to laws.map.json)
  const rlPath = join(root, "docs/laws/repo-law.json");
  if (existsSync(rlPath)) {
    const data = readJson(rlPath);
    if (data) {
      const mapRef = data.map;
      if (typeof mapRef === "string") {
        const mapAbs = join(root, mapRef);
        if (existsSync(mapAbs)) {
          // Redirect to the referenced map
          const mapData = readJson(mapAbs);
          if (mapData) {
            const laws = mapData.laws || {};
            const links = mapData.links || [];
            const lawRecords = Object.entries(laws).map(([id, law]) => ({
              id: stableId("law", mapRef, id),
              lawId: id,
              file: law.file || null,
              summary: law.summary?.slice(0, 120) || null,
            }));
            const bindingRecords = links.map((link, i) => ({
              id: stableId("law", mapRef, `binding-${i}`),
              lawIds: link.laws || [],
              paths: link.paths || [],
              kind: "binding",
            }));
            return { laws: lawRecords, bindings: bindingRecords };
          }
        }
      }
      // Fall back to repo-law.json itself
      return {
        laws: [
          {
            id: stableId("law", "docs/laws/repo-law.json", "repo-law"),
            lawId: "repo-law",
            file: "docs/laws/repo-law.json",
            summary: "Garisek-OS repo-law root (laws.map.json reference)",
          },
        ],
        bindings: [],
      };
    }
  }

  return { laws: [], bindings: [] };
}

// ── Verification driver extractor ─────────────────────────────────────────────

/**
 * Verification drivers: scripts that exercise the app end-to-end or verify
 * specific behaviors. Identified by filename patterns.
 */
const DRIVER_PATTERNS = [
  /^scripts\/e2e[-_]/,
  /^scripts\/verify[-_]/,
  /^scripts\/journey[-_]/,
  /^tests\/e2e\//,
  /^tests\/.*\.spec\./,
  /e2e[-_].*\.(mjs|ts|js)$/,
  /verify[-_].*\.(mjs|ts|js)$/,
  /journey[-_].*\.(mjs|ts|js)$/,
  /\.spec\.(mjs|ts|tsx|js|jsx)$/,
  /\.test\.(mjs|ts|tsx|js|jsx)$/,
  /^scripts\/loops\//,
  /^scripts\/probes\//,
];

function extractVerificationDrivers(allFiles) {
  return allFiles
    .filter((f) => DRIVER_PATTERNS.some((p) => p.test(f)))
    .map((f) => ({
      id: stableId("driver", f, basename(f)),
      path: f,
      name: basename(f),
    }));
}

// ── Required checks extractor ─────────────────────────────────────────────────

/**
 * Required checks: package.json scripts used as CI/quality gates.
 * Identified by well-known gate script names.
 */
const GATE_SCRIPTS = new Set([
  "build",
  "check",
  "lint",
  "typecheck",
  "type-check",
  "tsc",
  "test",
  "test:unit",
  "test:integration",
  "test:e2e",
  "verify",
  "verify:fast",
  "verify:dogfood",
  "guard",
  "guard:report",
  "validate",
  "audit",
  "preflight",
  "native:check",
  "tokens:check",
  "design:consolidation:check",
]);

function isGateScript(name) {
  if (GATE_SCRIPTS.has(name)) return true;
  if (/^(test|lint|check|verify|guard|audit|typecheck|build):/.test(name)) return true;
  return false;
}

function extractRequiredChecks(root) {
  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) return [];

  const pkg = readJson(pkgPath);
  if (!pkg?.scripts) return [];

  return Object.entries(pkg.scripts)
    .filter(([name]) => isGateScript(name))
    .map(([name, cmd]) => ({
      id: stableId("check", "package.json", name),
      name,
      command: cmd,
      file: "package.json",
    }));
}

// ── Main inventory builder ─────────────────────────────────────────────────────

async function buildInventory() {
  // 1. Git metadata
  const revision = execSync("git rev-parse HEAD", { cwd: repoRoot }).toString().trim();
  const frozenAt = new Date().toISOString();

  // 2. File list from git ls-files
  const allFiles = gitLsFiles(repoRoot);

  // 3. Categorize files
  const includedFiles = [];
  const excludedFiles = [];

  for (const relPath of allFiles) {
    const excl = getExclusion(relPath);
    if (excl) {
      excludedFiles.push({ path: relPath, reason: excl.reason, category: excl.category });
    } else {
      includedFiles.push(relPath);
    }
  }

  // 4. File records with language and sha256
  const fileRecords = [];
  const langCounts = {};

  for (const relPath of includedFiles) {
    const absPath = join(repoRoot, relPath);
    const lang = classifyLang(relPath);
    langCounts[lang] = (langCounts[lang] || 0) + 1;

    fileRecords.push({
      id: stableId("file", relPath, null),
      path: relPath,
      language: lang,
      sha256: sha256File(absPath),
    });
  }

  // Sort for determinism
  fileRecords.sort((a, b) => a.path.localeCompare(b.path));

  // 5. Symbol and component extraction (TS/TSX/JS/MJS only)
  const symbolRecords = [];
  const componentRecords = [];
  const missingExtractors = new Set();
  const missingExtractorFileCounts = {};

  for (const file of fileRecords) {
    const lang = file.language;

    if (EXTRACTABLE.has(lang)) {
      const absPath = join(repoRoot, file.path);
      const { symbols, components } = extractSymbolsTs(absPath, file.path, lang);
      symbolRecords.push(...symbols);
      componentRecords.push(...components);
    } else if (
      ![
        "json",
        "jsonl",
        "yaml",
        "toml",
        "markdown",
        "mdx",
        "css",
        "scss",
        "html",
        "sql",
        "shell",
        "graphql",
        "protobuf",
        "terraform",
        "other",
      ].includes(lang)
    ) {
      // Languages that could contain first-party code but lack an extractor
      missingExtractors.add(lang);
      missingExtractorFileCounts[lang] = (missingExtractorFileCounts[lang] || 0) + 1;
    }
  }

  // Sort for determinism
  symbolRecords.sort((a, b) => a.id.localeCompare(b.id));
  componentRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 6. Routes
  const routeRecords = [];
  for (const appRelRoot of ["src/app", "app"]) {
    const appDir = join(repoRoot, appRelRoot);
    if (existsSync(appDir)) {
      routeRecords.push(...extractRoutes(repoRoot, appRelRoot));
      break;
    }
  }
  routeRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 7. Features
  const rawFeatures = extractFeatures(repoRoot);
  const featureRecords = rawFeatures || [];
  featureRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 8. Laws and bindings
  const { laws: lawRecords, bindings: bindingRecords } = extractLaws(repoRoot);
  lawRecords.sort((a, b) => a.id.localeCompare(b.id));
  bindingRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 9. Verification drivers
  const driverRecords = extractVerificationDrivers(includedFiles);
  driverRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 10. Required checks
  const checkRecords = extractRequiredChecks(repoRoot);
  checkRecords.sort((a, b) => a.id.localeCompare(b.id));

  // 11. Compile missing extractor information
  const missingExtractorRecords = [...missingExtractors].sort().map((lang) => ({
    language: lang,
    fileCount: missingExtractorFileCounts[lang] || 0,
    extractor: "missing",
    impact: "M01 stays FAIL for this language until an extractor is implemented",
  }));

  // 12. Counts
  const counts = {
    files: fileRecords.length,
    symbols: symbolRecords.length,
    components: componentRecords.length,
    routes: routeRecords.length,
    features: rawFeatures ? featureRecords.length : null,
    featuresExtractor: rawFeatures ? "present" : "missing",
    laws: lawRecords.length,
    bindings: bindingRecords.length,
    drivers: driverRecords.length,
    checks: checkRecords.length,
    excluded: excludedFiles.length,
    languageBreakdown: langCounts,
    missingExtractors: missingExtractorRecords,
  };

  // 13. Assemble manifest (without top-level sha256 first)
  const manifest = {
    schema: "garisek.inventory/1",
    repo: repoId,
    revision,
    frozenAt,
    extractorContract: {
      description:
        "TS/TSX/JS/MJS: exported and top-level declarations extracted via TypeScript compiler AST. Kinds: function, class, const, type, interface, enum, re-export, export-default. React components: TSX/JSX functions or consts with uppercase name containing JSX, classified exported/reusable vs local.",
      languages: ["typescript", "tsx", "javascript", "jsx"],
      backend: ts
        ? `typescript@${readJson(join(repoRoot, "node_modules/typescript/package.json"))?.version || "unknown"} (project-local)`
        : "regex-fallback (TypeScript not found)",
    },
    includeRoots: [repoRoot],
    generatedSourcePolicy:
      "Excluded: .next/, dist/, target/, android/build/, *.tsbuildinfo. All other git-tracked files treated as first-party source regardless of generation.",
    exclusions: EXCLUSIONS.map((e) => ({
      pattern: e.pattern.toString(),
      reason: e.reason,
      category: e.category,
    })),
    counts,
    files: fileRecords,
    symbols: symbolRecords,
    components: componentRecords,
    routes: routeRecords,
    features: featureRecords,
    laws: lawRecords,
    bindings: bindingRecords,
    drivers: driverRecords,
    checks: checkRecords,
    excluded: excludedFiles,
  };

  // 14. Canonical JSON for content digest (excludes frozenAt and sha256 so digest is
  //     deterministic across re-runs of the same frozen worktree).
  const contentForHash = { ...manifest };
  delete contentForHash.frozenAt;
  const canonicalJson = JSON.stringify(contentForHash, sortedReplacer, 2);
  manifest.sha256 = sha256String(canonicalJson);

  // 15. Write output
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(manifest, sortedReplacer, 2), "utf8");

  console.log(
    JSON.stringify(
      {
        repo: repoId,
        revision,
        frozenAt,
        counts: { ...counts, missingExtractors: missingExtractorRecords.length },
        sha256: manifest.sha256,
        out: outFile,
      },
      null,
      2,
    ),
  );
}

function sortedReplacer(key, value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  }
  return value;
}

buildInventory().catch((e) => {
  console.error("inventory failed:", e);
  process.exit(1);
});

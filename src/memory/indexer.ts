import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname, dirname, sep } from "node:path";
import { execSync } from "node:child_process";
import type { CodebaseIndex, ModuleNode, RouteEntry } from "./store.js";
import { repoFullName } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Indexeur structurel — 100% local, 0 token, déterministe (même input → même
// output). Heuristiques regex pragmatiques pour TS/JS/Python ; le point
// d'extension propre pour passer à tree-sitter plus tard est extractFile().
// ─────────────────────────────────────────────────────────────────────────────

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "coverage",
  "vendor", "__pycache__", ".venv", "venv", ".kurtel", ".claude", ".idea", ".vscode",
]);

// Filtrage anti-bruit (la leçon Graphify) : on indexe le code, pas les assets/config.
const IGNORE_FILES = /\.(min\.js|d\.ts|test\.[jt]sx?|spec\.[jt]sx?|stories\.[jt]sx?)$|(^|\/)(conftest|setup)\.py$/;

interface FileFacts {
  rel: string;
  loc: number;
  exports: string[];
  importSpecs: string[];   // spécificateurs bruts ("./foo", "../lib/bar", "app.models")
  routes: RouteEntry[];
  /** Fonctions/méthodes définies dans le fichier. */
  defs: { name: string; line: number }[];
  /** Imports nommés: nom local → spécificateur source ("chargeCustomer" → "./service"). */
  namedImports: Record<string, string>;
  /** Sites d'appel candidats: nom appelé + ligne (résolus en post-passe). */
  rawCalls: { name: string; line: number }[];
}

// ── Extraction par fichier ──────────────────────────────────────────────────

interface RoutePattern {
  re: RegExp;
  framework: string;
  method: (m: RegExpMatchArray) => string;
  path: (m: RegExpMatchArray) => string;
}

// Patterns par langage — jamais croisés (sinon `@app.get(...)` Python matche aussi le pattern Express).
const JS_ROUTE_PATTERNS: RoutePattern[] = [
  // Express / Fastify / Koa-router (router.get("/x"), app.post('/y'))
  {
    re: /\b(?:app|router|server|api|fastify)\s*\.\s*(get|post|put|patch|delete|head|options|all)\s*\(\s*["'`]([^"'`]+)["'`]/g,
    framework: "express-like",
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2],
  },
  // Décorateurs Nest: @Get("/x"), @Post()
  {
    re: /@(Get|Post|Put|Patch|Delete|Head|Options)\s*\(\s*(?:["'`]([^"'`]*)["'`])?\s*\)/g,
    framework: "nest",
    method: (m) => m[1].toUpperCase(),
    path: (m) => m[2] ?? "",
  },
];

const PY_ROUTE_PATTERNS: RoutePattern[] = [
  // FastAPI / Flask: @app.get("/x"), @router.post("/y"), @app.route("/z", methods=["POST"])
  {
    re: /@\s*[\w.]+\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/g,
    framework: "python",
    method: (m) => (m[1] === "route" ? "*" : m[1].toUpperCase()),
    path: (m) => m[2],
  },
];

const NEXT_ROUTE_FILE = /(^|\/)(pages|app)\/(.+?)\/?(route|page|index)?\.(ts|tsx|js|jsx)$/;

const JS_KEYWORDS = new Set([
  "if", "for", "while", "switch", "catch", "return", "function", "new", "typeof",
  "await", "async", "import", "export", "require", "console", "constructor",
  "super", "this", "throw", "delete", "void", "in", "of", "do", "else", "try",
]);
const PY_KEYWORDS = new Set([
  "if", "for", "while", "return", "print", "len", "range", "str", "int", "dict",
  "list", "set", "tuple", "type", "isinstance", "super", "open", "enumerate",
]);

function lineOf(src: string, index: number): number {
  let n = 1;
  for (let i = 0; i < index; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

function extractFile(root: string, rel: string, src: string): FileFacts {
  const lines = src.split("\n");
  const facts: FileFacts = {
    rel, loc: lines.length, exports: [], importSpecs: [], routes: [],
    defs: [], namedImports: {}, rawCalls: [],
  };
  const ext = extname(rel);
  const isPy = ext === ".py";

  if (isPy) {
    for (const m of src.matchAll(/^\s*(?:from\s+([\w.]+)\s+import\s+([\w ,]+)|import\s+([\w.]+))/gm)) {
      facts.importSpecs.push(m[1] ?? m[3]);
      // from x import a, b → imports nommés
      if (m[1] && m[2]) {
        for (const name of m[2].split(",").map((s) => s.trim().split(/\s+as\s+/)[0])) {
          if (/^\w+$/.test(name)) facts.namedImports[name] = m[1];
        }
      }
    }
    for (const m of src.matchAll(/^(?:\s*)(?:async\s+)?def\s+(\w+)/gm)) {
      facts.exports.push(m[1]);
      facts.defs.push({ name: m[1], line: lineOf(src, m.index ?? 0) });
    }
    for (const m of src.matchAll(/^class\s+(\w+)/gm)) facts.exports.push(m[1]);
  } else {
    for (const m of src.matchAll(/import\s+(?:type\s+)?(?:(\w+)\s*,?\s*)?(?:{([^}]*)})?\s*from\s+["']([^"']+)["']|\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const spec = m[3] ?? m[4];
      if (!spec) continue;
      facts.importSpecs.push(spec);
      if (m[1]) facts.namedImports[m[1]] = spec; // import défaut
      if (m[2]) {
        for (const part of m[2].split(",")) {
          const name = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (name && /^\w+$/.test(name)) facts.namedImports[name] = spec;
        }
      }
    }
    // Définitions: function decl, const fléchée, méthodes de classe.
    for (const m of src.matchAll(/\b(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+(\w+)/g)) {
      facts.defs.push({ name: m[1], line: lineOf(src, m.index ?? 0) });
    }
    for (const m of src.matchAll(/\b(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+)?=>/g)) {
      facts.defs.push({ name: m[1], line: lineOf(src, m.index ?? 0) });
    }
    for (const m of src.matchAll(/^\s{2,}(?:public\s+|private\s+|protected\s+|static\s+)*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[\w<>[\]| .]+)?\s*{/gm)) {
      if (!JS_KEYWORDS.has(m[1])) facts.defs.push({ name: m[1], line: lineOf(src, m.index ?? 0) });
    }
    for (const m of src.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g)) {
      facts.exports.push(m[1]);
    }
  }

  // Dédupe les defs (même nom: garder la première occurrence), tri par ligne.
  const seen = new Set<string>();
  facts.defs = facts.defs
    .sort((a, b) => a.line - b.line)
    .filter((d) => (seen.has(d.name) ? false : (seen.add(d.name), true)))
    .slice(0, 40);

  // Sites d'appel candidats: identifiant suivi de "(", hors mots-clés.
  const kw = isPy ? PY_KEYWORDS : JS_KEYWORDS;
  let count = 0;
  for (const m of src.matchAll(/(?<![\w.])([A-Za-z_]\w{2,})\s*\(/g)) {
    if (kw.has(m[1])) continue;
    facts.rawCalls.push({ name: m[1], line: lineOf(src, m.index ?? 0) });
    if (++count >= 800) break;
  }
  // Appels qualifiés "Prefix.method(" → candidat "Prefix." (résolu vers la
  // classe/module importé en post-passe; le point final marque le cas qualifié).
  for (const m of src.matchAll(/(?<![\w.])([A-Z]\w{2,})\.\w+\s*\(/g)) {
    if (kw.has(m[1])) continue;
    facts.rawCalls.push({ name: m[1] + ".", line: lineOf(src, m.index ?? 0) });
    if (++count >= 1000) break;
  }
  facts.rawCalls.sort((a, b) => a.line - b.line);

  // Routes par appel/décorateur, avec n° de ligne — patterns du bon langage uniquement.
  const routePatterns = ext === ".py" ? PY_ROUTE_PATTERNS : JS_ROUTE_PATTERNS;
  for (const p of routePatterns) {
    for (const m of src.matchAll(p.re)) {
      const upto = src.slice(0, m.index ?? 0);
      facts.routes.push({
        method: p.method(m),
        path: p.path(m),
        file: rel,
        line: upto.split("\n").length,
        framework: p.framework,
      });
    }
  }

  // Routes par convention de fichier (Next.js app/pages router).
  const nm = rel.replace(/\\/g, "/").match(NEXT_ROUTE_FILE);
  if (nm) {
    const urlPath = "/" + nm[3].replace(/\[(\w+)\]/g, ":$1").replace(/\/index$/, "");
    facts.routes.push({ method: "*", path: urlPath, file: rel, line: 1, framework: "next" });
  }

  return facts;
}

// ── Résolution d'imports internes (TS/JS relatifs + Python par module path) ──

function buildResolver(all: Map<string, FileFacts>): (rel: string, spec: string) => string | undefined {
  const byNoExt = new Map<string, string>();
  for (const rel of all.keys()) {
    const noExt = rel.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py)$/, "");
    byNoExt.set(noExt.replace(/\\/g, "/"), rel);
    if (noExt.endsWith("/index")) byNoExt.set(noExt.slice(0, -"/index".length), rel);
    if (noExt.endsWith("/__init__")) byNoExt.set(noExt.slice(0, -"/__init__".length), rel);
  }
  return (rel: string, spec: string): string | undefined => {
    if (spec.startsWith(".")) {
      const base = join(dirname(rel), spec).replace(/\\/g, "/").replace(/\.(js|ts|tsx|jsx)$/, "");
      return byNoExt.get(base);
    }
    if (spec.includes(".") && extname(rel) === ".py") {
      return byNoExt.get(spec.replace(/\./g, "/"));
    }
    const cleaned = spec.replace(/^@\//, "src/").replace(/^~\//, "src/");
    return byNoExt.get(cleaned);
  };
}

function resolveImports(all: Map<string, FileFacts>): Map<string, string[]> {
  const resolve = buildResolver(all);
  const resolved = new Map<string, string[]>();
  for (const [rel, facts] of all) {
    const targets: string[] = [];
    for (const spec of facts.importSpecs) {
      const candidate = resolve(rel, spec);
      if (candidate && candidate !== rel) targets.push(candidate);
    }
    resolved.set(rel, [...new Set(targets)]);
  }
  return resolved;
}

// ── Graphe d'appels: résolution des sites d'appel en arêtes symbole→symbole ──

const MAX_SYMBOLS_PER_FILE = 25;
const MAX_CALLS_PER_SYMBOL = 15;

function buildSymbols(
  all: Map<string, FileFacts>,
  resolve: (rel: string, spec: string) => string | undefined
): Map<string, { name: string; line: number; calls: string[] }[]> {
  const defNames = new Map<string, Set<string>>();
  const exportNames = new Map<string, Set<string>>();
  for (const [rel, f] of all) {
    defNames.set(rel, new Set(f.defs.map((d) => d.name)));
    exportNames.set(rel, new Set(f.exports));
  }

  const out = new Map<string, { name: string; line: number; calls: string[] }[]>();
  for (const [rel, f] of all) {
    const locals = defNames.get(rel)!;
    const symbols = f.defs.slice(0, MAX_SYMBOLS_PER_FILE).map((d) => ({ ...d, calls: [] as string[] }));
    // Pseudo-symbole pour les appels hors fonction (handlers de routes inline,
    // initialisation module) — c'est là que vivent les arêtes des fichiers routes.
    const topLevel = { name: "(module)", line: 0, calls: [] as string[] };

    const resolveCall = (raw: string): string | null => {
      const qualified = raw.endsWith(".");
      const name = qualified ? raw.slice(0, -1) : raw;
      if (!qualified && locals.has(name)) return `${rel}::${name}`;
      const spec = f.namedImports[name];
      if (spec) {
        const file = resolve(rel, spec);
        if (file && file !== rel && (defNames.get(file)?.has(name) || exportNames.get(file)?.has(name))) {
          return `${file}::${name}`;
        }
      }
      return null;
    };

    for (const call of f.rawCalls) {
      let caller: { name: string; line: number; calls: string[] } = topLevel;
      for (const s of symbols) {
        if (s.line <= call.line) caller = s;
        else break;
      }
      if (caller.name === call.name || caller.calls.length >= MAX_CALLS_PER_SYMBOL) continue;
      const target = resolveCall(call.name);
      if (target && target !== `${rel}::${caller.name}` && !caller.calls.includes(target)) {
        caller.calls.push(target);
      }
    }

    out.set(rel, topLevel.calls.length ? [topLevel, ...symbols] : symbols);
  }
  return out;
}

// ── Parcours ────────────────────────────────────────────────────────────────

function* walk(dir: string, root: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".") continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (!IGNORE_DIRS.has(name)) yield* walk(full, root);
    } else if (st.isFile() && st.size < 1_000_000) {
      const rel = relative(root, full).replace(/\\/g, "/");
      if (CODE_EXT.has(extname(name)) && !IGNORE_FILES.test(rel)) yield rel;
    }
  }
}

// ── Construction de l'index ─────────────────────────────────────────────────

export function buildIndex(root: string, onProgress?: (n: number) => void): CodebaseIndex {
  const files = new Map<string, FileFacts>();
  let n = 0;
  for (const rel of walk(root, root)) {
    try {
      const src = readFileSync(join(root, rel), "utf8");
      files.set(rel, extractFile(root, rel, src));
      if (onProgress && ++n % 50 === 0) onProgress(n);
    } catch { /* binaire/illisible: skip */ }
  }

  const imports = resolveImports(files);
  const symbolMap = buildSymbols(files, buildResolver(files));
  const inDegree = new Map<string, number>();
  for (const targets of imports.values()) {
    for (const t of targets) inDegree.set(t, (inDegree.get(t) ?? 0) + 1);
  }

  const modules: ModuleNode[] = [...files.entries()]
    .map(([rel, f]) => {
      const out = imports.get(rel) ?? [];
      return {
        id: rel,
        exports: f.exports.slice(0, 30),
        imports: out,
        loc: f.loc,
        degree: out.length + (inDegree.get(rel) ?? 0),
        symbols: symbolMap.get(rel) ?? [],
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id)); // tri stable → déterminisme

  const god_nodes = [...modules]
    .sort((a, b) => b.degree - a.degree || a.id.localeCompare(b.id))
    .slice(0, 10)
    .filter((m) => m.degree >= 5)
    .map((m) => ({ id: m.id, degree: m.degree }));

  const domainMap = new Map<string, { files: number; loc: number }>();
  for (const m of modules) {
    const top = m.id.includes("/") ? m.id.split("/")[0] : "(root)";
    const d = domainMap.get(top) ?? { files: 0, loc: 0 };
    d.files += 1; d.loc += m.loc;
    domainMap.set(top, d);
  }
  const domains = [...domainMap.entries()]
    .map(([name, d]) => ({ name, ...d }))
    .sort((a, b) => b.loc - a.loc);

  const routes = [...files.values()].flatMap((f) => f.routes)
    .sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

  let commit = "unknown";
  try {
    commit = execSync("git rev-parse HEAD", { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch { /* pas un repo git */ }

  return {
    version: 1,
    repo: repoFullName(root),
    commit,
    generated_at: new Date().toISOString(),
    files_indexed: files.size,
    routes,
    modules,
    god_nodes,
    domains,
  };
}

// ── Rapport d'audit (le "moment wow" du jour 0) ─────────────────────────────

export function renderReport(index: CodebaseIndex): string {
  const lines: string[] = [];
  lines.push(`# Kurtel — Architecture Report`);
  lines.push(``);
  lines.push(`Repo **${index.repo}** · ${index.files_indexed} files indexed · commit \`${index.commit.slice(0, 8)}\` · ${index.generated_at}`);
  lines.push(``);

  lines.push(`## Domains`);
  for (const d of index.domains.slice(0, 12)) {
    lines.push(`- **${d.name}** — ${d.files} files, ${d.loc.toLocaleString()} LOC`);
  }
  lines.push(``);

  if (index.god_nodes.length) {
    lines.push(`## God nodes (high-coupling hotspots)`);
    lines.push(`These modules concentrate the most connections; changes here have the widest blast radius.`);
    for (const g of index.god_nodes) {
      lines.push(`- \`${g.id}\` — **${g.degree} edges**`);
    }
    lines.push(``);
  }

  lines.push(`## Route inventory (${index.routes.length})`);
  lines.push(`The agent receives this inventory before creating any endpoint — duplicates get flagged.`);
  const byFw = new Map<string, RouteEntry[]>();
  for (const r of index.routes) {
    const arr = byFw.get(r.framework) ?? [];
    arr.push(r); byFw.set(r.framework, arr);
  }
  for (const [fw, rs] of byFw) {
    lines.push(``);
    lines.push(`### ${fw}`);
    for (const r of rs.slice(0, 80)) {
      lines.push(`- \`${r.method.padEnd(6)} ${r.path}\` → ${r.file}:${r.line}`);
    }
    if (rs.length > 80) lines.push(`- … and ${rs.length - 80} more`);
  }
  lines.push(``);
  return lines.join("\n");
}

// ── Recherche de routes proches (anti-duplication) ──────────────────────────

/** Similarité grossière entre deux chemins de route (segments partagés, params normalisés). */
function routeSimilarity(a: string, b: string): number {
  const norm = (p: string) => p.replace(/:(\w+)|\{(\w+)\}|\[(\w+)\]/g, ":p").toLowerCase()
    .split("/").filter(Boolean);
  const sa = norm(a), sb = norm(b);
  if (!sa.length || !sb.length) return 0;
  let shared = 0;
  for (let i = 0; i < Math.min(sa.length, sb.length); i++) if (sa[i] === sb[i]) shared++;
  return (2 * shared) / (sa.length + sb.length);
}

export function findSimilarRoutes(index: CodebaseIndex, path: string, threshold = 0.6): RouteEntry[] {
  return index.routes
    .map((r) => ({ r, s: routeSimilarity(r.path, path) }))
    .filter((x) => x.s >= threshold)
    .sort((a, b) => b.s - a.s)
    .slice(0, 5)
    .map((x) => x.r);
}

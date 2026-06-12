import type { CodebaseIndex } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Moteur d'impact — la question "qu'est-ce qui casse si je change X ?"
// répondue par BFS inverse sur deux graphes superposés:
//   · fichier→fichier (imports)
//   · symbole→symbole (graphe d'appels)
// Le même moteur sert l'app (mode impact du graphe) ET l'agent (kurtel impact).
// ─────────────────────────────────────────────────────────────────────────────

export interface ImpactLayer {
  depth: number;
  files: string[];
}

export interface SymbolImpactEntry {
  symbol: string;          // "file.ts::fn"
  depth: number;
  via: string;             // le symbole qu'il appelle (chaîne de propagation)
}

export interface ImpactResult {
  target: string;                      // fichier ou "fichier::fonction"
  kind: "file" | "symbol";
  direct: number;                      // dépendants à distance 1
  transitive: number;                  // total ≤ maxDepth
  layers: ImpactLayer[];               // fichiers impactés par profondeur
  symbols: SymbolImpactEntry[];        // chaîne d'appels inverses (si kind=symbol ou dispo)
  affectedRoutes: { method: string; path: string; file: string }[];
  truncated: boolean;
}

/** Adjacences inverses précalculées depuis l'index. */
export function buildReverse(index: CodebaseIndex) {
  const fileRev = new Map<string, string[]>();          // file ← importeurs
  const symbolRev = new Map<string, { from: string; via: string }[]>(); // "f::fn" ← appelants
  for (const m of index.modules) {
    for (const t of m.imports) {
      (fileRev.get(t) ?? fileRev.set(t, []).get(t)!).push(m.id);
    }
    for (const s of m.symbols ?? []) {
      const from = `${m.id}::${s.name}`;
      for (const call of s.calls) {
        (symbolRev.get(call) ?? symbolRev.set(call, []).get(call)!).push({ from, via: call });
      }
    }
  }
  return { fileRev, symbolRev };
}

const MAX_NODES = 400;

/** Résout une cible libre: "src/billing/service.ts", "service.ts::chargeCustomer", ou juste "chargeCustomer". */
export function resolveTarget(index: CodebaseIndex, query: string): { id: string; kind: "file" | "symbol" } | null {
  const q = query.trim().replace(/\\/g, "/");
  if (q.includes("::")) {
    const [file, fn] = q.split("::");
    const mod = index.modules.find((m) => m.id === file || m.id.endsWith("/" + file));
    if (mod?.symbols?.some((s) => s.name === fn)) return { id: `${mod.id}::${fn}`, kind: "symbol" };
    return null;
  }
  const exact = index.modules.find((m) => m.id === q);
  if (exact) return { id: exact.id, kind: "file" };
  const suffix = index.modules.filter((m) => m.id.endsWith("/" + q) || m.id.endsWith(q));
  if (suffix.length === 1) return { id: suffix[0].id, kind: "file" };
  // nom de fonction seul: unique dans le repo ?
  const owners = index.modules.filter((m) => m.symbols?.some((s) => s.name === q));
  if (owners.length === 1) return { id: `${owners[0].id}::${q}`, kind: "symbol" };
  return null;
}

export function computeImpact(
  index: CodebaseIndex,
  target: { id: string; kind: "file" | "symbol" },
  maxDepth = 4
): ImpactResult {
  const { fileRev, symbolRev } = buildReverse(index);
  const fileDepth = new Map<string, number>();
  const symbols: SymbolImpactEntry[] = [];
  let truncated = false;

  if (target.kind === "symbol") {
    // BFS inverse sur le graphe d'appels; les fichiers porteurs héritent de la profondeur.
    const seen = new Map<string, number>([[target.id, 0]]);
    let frontier = [target.id];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const sym of frontier) {
        for (const caller of symbolRev.get(sym) ?? []) {
          if (seen.has(caller.from)) continue;
          if (seen.size >= MAX_NODES) { truncated = true; break; }
          seen.set(caller.from, d);
          symbols.push({ symbol: caller.from, depth: d, via: sym });
          next.push(caller.from);
          const file = caller.from.split("::")[0];
          if (!fileDepth.has(file)) fileDepth.set(file, d);
        }
      }
      frontier = next;
    }
    // Le fichier hôte du symbole est impacté à profondeur 0 (on le modifie).
    fileDepth.set(target.id.split("::")[0], 0);
  } else {
    const seen = new Map<string, number>([[target.id, 0]]);
    let frontier = [target.id];
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const importer of fileRev.get(f) ?? []) {
          if (seen.has(importer)) continue;
          if (seen.size >= MAX_NODES) { truncated = true; break; }
          seen.set(importer, d);
          next.push(importer);
        }
      }
      frontier = next;
    }
    for (const [f, d] of seen) if (d > 0) fileDepth.set(f, d);
    // Bonus: appels symboliques inverses depuis tous les symboles du fichier (profondeur 1 du détail).
    const mod = index.modules.find((m) => m.id === target.id);
    for (const s of mod?.symbols ?? []) {
      for (const caller of symbolRev.get(`${target.id}::${s.name}`) ?? []) {
        symbols.push({ symbol: caller.from, depth: 1, via: `${target.id}::${s.name}` });
        if (symbols.length >= 60) break;
      }
    }
  }

  const byDepth = new Map<number, string[]>();
  for (const [f, d] of fileDepth) {
    if (d === 0) continue;
    (byDepth.get(d) ?? byDepth.set(d, []).get(d)!).push(f);
  }
  const layers: ImpactLayer[] = [...byDepth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([depth, files]) => ({ depth, files: files.sort() }));

  const impactedFiles = new Set(fileDepth.keys());
  const affectedRoutes = index.routes
    .filter((r) => impactedFiles.has(r.file))
    .map((r) => ({ method: r.method, path: r.path, file: r.file }))
    .slice(0, 40);

  return {
    target: target.id,
    kind: target.kind,
    direct: layers[0]?.files.length ?? 0,
    transitive: layers.reduce((s, l) => s + l.files.length, 0),
    layers,
    symbols: symbols.slice(0, 60),
    affectedRoutes,
    truncated,
  };
}

/** Rendu texte compact pour l'agent (~ borné, lisible par un LLM). */
export function renderImpactForAgent(r: ImpactResult): string {
  const lines: string[] = [];
  lines.push(`[Impact analysis] ${r.target} (${r.kind})`);
  lines.push(`Direct dependents: ${r.direct} · transitive (≤4 hops): ${r.transitive}${r.truncated ? " (truncated)" : ""}`);
  for (const layer of r.layers.slice(0, 3)) {
    lines.push(`Depth ${layer.depth}: ${layer.files.slice(0, 10).join(", ")}${layer.files.length > 10 ? ` … +${layer.files.length - 10}` : ""}`);
  }
  if (r.symbols.length) {
    lines.push(`Call chain (who calls this):`);
    for (const s of r.symbols.slice(0, 10)) lines.push(`  d${s.depth} ${s.symbol} → ${s.via}`);
  }
  if (r.affectedRoutes.length) {
    lines.push(`Routes in blast radius:`);
    for (const rt of r.affectedRoutes.slice(0, 8)) lines.push(`  ${rt.method} ${rt.path} (${rt.file})`);
  }
  let out = lines.join("\n");
  if (out.length > 1800) out = out.slice(0, 1799) + "…";
  return out;
}

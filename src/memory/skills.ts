import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { join } from "node:path";

// ── Collecte des skills écrits à la main ──────────────────────────────────────
// Convention produit: l'utilisateur dépose TOUS ses skills dans un dossier
// `skills/` à la racine du repo. À l'onboarding (si connecté), on lit ce dossier
// et le backend en distille des patterns darwiniens — pour qu'il n'ait plus à les
// maintenir à la main. Lecture SEULE, best-effort: jamais d'échec bloquant.
//
// Pas de troncature ni de cap sur le NOMBRE de skills: on envoie chaque skill
// ENTIER, et autant qu'il y en a (l'import ne se fait qu'une fois par repo côté
// backend). Les seules bornes ci-dessous sont des garde-fous anti-pathologie
// (boucle de symlinks / arborescence absurde) — jamais atteints en usage réel.

const MAX_DEPTH = 8;
const MAX_FILES_SCANNED = 5000;

export interface SkillDoc {
  path: string; // relatif à la racine du repo, séparateurs "/"
  content: string;
}

/** Le dossier `skills/` à la racine du repo (la convention où l'utilisateur range ses skills). */
function skillDirs(root: string): string[] {
  return [join(root, "skills")];
}

function walkMd(dir: string, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES_SCANNED) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".git")) continue;
      walkMd(p, depth + 1, out);
    } else if (e.isFile() && e.name.toLowerCase().endsWith(".md")) {
      out.push(p);
    }
  }
}

/** Récupère tous les docs de skills du repo (entiers), dédoublonnés par chemin. */
export function collectSkillDocs(root: string): SkillDoc[] {
  const files: string[] = [];
  for (const d of skillDirs(root)) {
    if (existsSync(d)) walkMd(d, 0, files);
  }
  // Ordre déterministe (l'ordre de readdir ne l'est pas selon l'OS/FS).
  files.sort();

  const docs: SkillDoc[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const rel = f.startsWith(root) ? f.slice(root.length + 1) : f;
    const relPosix = rel.replace(/\\/g, "/");
    if (seen.has(relPosix)) continue;
    let content = "";
    try {
      content = readFileSync(f, "utf8"); // skill entier, pas de coupe
    } catch {
      continue;
    }
    if (content.trim().length < 20) continue;
    seen.add(relPosix);
    docs.push({ path: relPosix, content });
  }
  return docs;
}

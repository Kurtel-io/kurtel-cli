import { spawn } from "node:child_process";
import { loadMemoryCache, saveMemoryCache, repoFullName } from "./store.js";
import { pullPatterns, pushTelemetry, pushIndex } from "./api.js";
import { loadIndex } from "./store.js";

// ── Sync ──
// Règle d'or: aucun appel réseau sur le chemin critique d'un prompt — les hooks lisent le cache, le sync tourne détaché.

/** Sync synchrone (utilisé par `kurtel memory sync` et le process détaché). */
export async function syncNow(root: string): Promise<{ pulled: number; flushed: number }> {
  const repo = repoFullName(root);
  const cache = loadMemoryCache(root);

  let pulled = 0;
  try {
    const res = await pullPatterns(repo, cache.patterns_synced_at);
    if (res.delta) {
      const byId = new Map(cache.patterns.map((p) => [p.id, p]));
      for (const p of res.patterns) byId.set(p.id, p);
      cache.patterns = [...byId.values()].filter((p) => p.score > 0); // score 0 = mort, purgé
    } else {
      cache.patterns = res.patterns;
    }
    cache.patterns_synced_at = res.synced_at;
    pulled = res.patterns.length;
  } catch { /* offline / pas loggé: le cache continue de servir */ }

  let flushed = 0;
  if (cache.pending_telemetry.length) {
    try {
      await pushTelemetry(repo, cache.pending_telemetry);
      flushed = cache.pending_telemetry.length;
      cache.pending_telemetry = [];
    } catch { /* on réessaiera au prochain sync */ }
  }

  saveMemoryCache(root, cache);
  return { pulled, flushed };
}

/** Push de l'index de codebase vers le backend (pour l'onglet Memory in-app). */
export async function syncIndexUp(root: string): Promise<boolean> {
  const index = loadIndex(root);
  if (!index) return false;
  try {
    await pushIndex(index.repo, index);
    return true;
  } catch {
    return false;
  }
}

/** Lance un sync en arrière-plan, détaché — fire & forget, jamais bloquant. */
export function syncInBackground(root: string): void {
  try {
    const child = spawn(process.execPath, [process.argv[1], "memory", "sync", "--quiet"], {
      cwd: root,
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      env: process.env,
    });
    child.on("error", () => {});
    child.unref();
  } catch { /* best effort */ }
}

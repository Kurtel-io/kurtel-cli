import { spawn } from "node:child_process";
import { loadMemoryCache, saveMemoryCache, repoFullName, dedupePatterns } from "./store.js";
import { pullPatterns, pushTelemetry, pushIndex } from "./api.js";
import { loadIndex, headCommit } from "./store.js";

// ── Sync ──
// Règle d'or: aucun appel réseau sur le chemin critique d'un prompt — les hooks lisent le cache, le sync tourne détaché.

// Le delta (par `id`) ne sait pas retirer un skill HARD-deleté côté serveur
// (suppression UI, table vidée + ré-onboard): son id disparaît sans qu'aucun
// `updated_at > since` ne le signale → orphelin éternel dans le cache. On force
// donc périodiquement un snapshot COMPLET qui remplace le cache et purge ces
// orphelins. Fenêtre courte: un pull complet (≤500 lignes) est bon marché.
const FULL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

function needsFullSync(fullSyncedAt: string | null | undefined): boolean {
  if (!fullSyncedAt) return true;
  const age = Date.now() - new Date(fullSyncedAt).getTime();
  return !(age >= 0 && age < FULL_SYNC_INTERVAL_MS); // NaN / horloge en arrière → on resynchronise
}

/** Sync synchrone (utilisé par `kurtel memory sync` et le process détaché). */
export async function syncNow(root: string): Promise<{ pulled: number; flushed: number }> {
  const repo = repoFullName(root);
  const cache = loadMemoryCache(root);

  let pulled = 0;
  try {
    // `since = null` ⇒ le backend renvoie un snapshot complet (delta=false).
    const full = needsFullSync(cache.full_synced_at);
    const res = await pullPatterns(repo, full ? null : cache.patterns_synced_at);
    if (res.delta) {
      const byId = new Map(cache.patterns.map((p) => [p.id, p]));
      for (const p of res.patterns) byId.set(p.id, p);
      cache.patterns = [...byId.values()].filter((p) => p.score > 0); // score 0 = mort, purgé
    } else {
      cache.patterns = res.patterns; // snapshot complet → orphelins hard-deletés purgés
      cache.full_synced_at = res.synced_at;
    }
    // Dernière ligne de défense: jamais deux fois la même règle dans le cache.
    cache.patterns = dedupePatterns(cache.patterns);
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
    await pushIndex(index.repo, index, headCommit(root));
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

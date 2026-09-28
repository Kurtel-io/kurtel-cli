import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { embeddingsPaths } from "./paths.js";

export function saveModuleVectors(root: string, mv: { dim: number; ids: string[]; matrix: Float32Array }): void {
  const { bin, meta } = embeddingsPaths(root);
  const dir = join(bin, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const buf = Buffer.alloc(mv.matrix.length * 4);
  for (let i = 0; i < mv.matrix.length; i++) buf.writeFloatLE(mv.matrix[i], i * 4);
  writeFileSync(bin, buf);
  writeFileSync(meta, JSON.stringify({ dim: mv.dim, ids: mv.ids }) + "\n", "utf8");
}

let mvCache: { root: string; map: Map<string, Float32Array> } | null = null;

export function loadModuleVectors(root: string): Map<string, Float32Array> | null {
  if (mvCache && mvCache.root === root) return mvCache.map;
  const { bin, meta } = embeddingsPaths(root);
  if (!existsSync(bin) || !existsSync(meta)) return null;
  try {
    const { dim, ids } = JSON.parse(readFileSync(meta, "utf8")) as { dim: number; ids: string[] };
    const buf = readFileSync(bin);
    const floats = new Float32Array(dim * ids.length);
    for (let i = 0; i < floats.length; i++) floats[i] = buf.readFloatLE(i * 4);
    const map = new Map<string, Float32Array>();
    for (let r = 0; r < ids.length; r++) map.set(ids[r], floats.subarray(r * dim, (r + 1) * dim));
    mvCache = { root, map };
    return map;
  } catch {
    return null;
  }
}

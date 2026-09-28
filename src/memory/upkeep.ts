// Whole-store work, run by background processes, never on the prompt path.
import { refreshKnowledgeVectors } from "../context/knowledge-vectors.js";
import { anchorKnowledge } from "./visibility.js";

export function backgroundUpkeep(root: string): void {
  try { anchorKnowledge(root); } catch { /* Store busy: next time. */ }
  try { refreshKnowledgeVectors(root, Number.POSITIVE_INFINITY); } catch { /* Derived data only. */ }
}

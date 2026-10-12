// Whole-store work, run by background processes, never on the prompt path.
import { refreshKnowledgeVectors } from "../context/knowledge-vectors.js";
import { refreshSentenceVectors } from "../context/selection.js";
import { anchorKnowledge } from "./visibility.js";

export function backgroundUpkeep(root: string): void {
  try { anchorKnowledge(root); } catch { /* Store busy: next time. */ }
  try { refreshKnowledgeVectors(root, Number.POSITIVE_INFINITY); } catch { /* Derived data only. */ }
  // Sentence vectors of the rules just learned; the process stays until they are saved.
  refreshSentenceVectors(root).catch(() => { /* Derived data only. */ });
}

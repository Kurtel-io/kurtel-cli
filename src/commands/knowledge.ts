import { recordDecisionTrace } from "../memory/decision-trace.js";
import { fetchDecisionSources, searchDecisionSources } from "../memory/decision-sources.js";
import { readFileSync } from "node:fs";
import { repoRoot } from "../repository/git.js";
import { appendKnowledge, knowledgePath, readKnowledge } from "../storage/knowledge.js";
import { validateKnowledge } from "../storage/knowledge-validation.js";
import { explainKnowledge, knowledgeHistory } from "../memory/knowledge-history.js";
import { renderKnowledge } from "../ui/knowledge.js";

export async function knowledgeCommand(action: string, file?: string, options: { json?: boolean; at?: string; depth?: string } = {}): Promise<void> {
  const root = repoRoot();
  if (action === "sources") {
    if (!file) throw new Error("Use knowledge sources <query or source-id>");
    console.log(JSON.stringify(searchDecisionSources(root, file), null, 2)); return;
  }
  if (action === "github") {
    if (!file) throw new Error("Use knowledge github <request.json>: repo, kind, ref, path, page");
    console.log(JSON.stringify(await fetchDecisionSources(root, JSON.parse(readFileSync(file, "utf8"))), null, 2)); return;
  }
  if (action === "trace") {
    if (!file) throw new Error("Use knowledge trace <trace.json>");
    console.log(JSON.stringify(recordDecisionTrace(root, JSON.parse(readFileSync(file, "utf8"))), null, 2)); return;
  }
  if (["why", "history", "counterexamples"].includes(action)) {
    if (!file) throw new Error(`Usage: kurtel knowledge ${action} "<id or search phrase>"`);
    const store = readKnowledge(root);
    const result = action === "history" ? knowledgeHistory(store, file, options.at) : explainKnowledge(store, file, { at: options.at, depth: options.depth === undefined ? undefined : Number(options.depth) });
    if (action === "counterexamples" && "counterexamples" in result && result.counterexamples) {
      if (options.json) process.stdout.write(JSON.stringify({ selected: result.selected, counterexamples: result.counterexamples, sources: result.sources }, null, 2) + "\n");
      else process.stdout.write(result.counterexamples.length ? renderKnowledge(result) + "\n" : "No counterexample recorded for this version. That does not prove there is none.\n");
    } else process.stdout.write((options.json ? JSON.stringify(result, null, 2) : renderKnowledge(result)) + "\n");
    return;
  }
  if (action === "import") {
    if (!file) throw new Error("Usage: kurtel knowledge import <store.json>");
    const imported: unknown = JSON.parse(readFileSync(file, "utf8"));
    const current = readKnowledge(root);
    validateKnowledge(imported, current.scope);
    appendKnowledge(root, () => imported, current.revision);
  } else if (action !== "status" && action !== "export") {
    throw new Error("Use: kurtel knowledge status | export | import | why | history | counterexamples | sources | github | trace");
  }
  const store = readKnowledge(root);
  const output = action === "export" ? store : {
    path: knowledgePath(root), schema_version: store.schema_version, revision: store.revision,
    sources: store.sources.length, events: store.events.length,
    knowledge: new Set(store.versions.map(v => v.knowledge_id)).size,
    versions: store.versions.length, relations: store.relations.length,
  };
  process.stdout.write(JSON.stringify(output, null, 2) + "\n");
}

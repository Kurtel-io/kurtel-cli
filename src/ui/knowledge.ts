import { explainKnowledge, knowledgeHistory } from "../memory/knowledge-history.js";

export function renderKnowledge(result: ReturnType<typeof explainKnowledge> | ReturnType<typeof knowledgeHistory>): string {
  if ("candidates" in result && result.candidates) {
    if (!result.candidates.length) return "No knowledge found. Try an exact ID or keywords.";
    return "Several matches; give the exact ID:\n" + result.candidates.map(v => `- ${v.id} [${v.state}] ${v.content}`).join("\n");
  }
  const lines: string[] = [];
  if ("selected" in result && result.selected) {
    const v = result.selected;
    lines.push(`${v.content}\n${v.id} · ${v.state} · version ${v.version}`);
    if (result.historical_version) lines.push(`Historical version; latest known version: ${result.current_version_id}`);
    if (!result.valid_at_query_time) lines.push("This version is outside its validity period at the requested date.");
    if (!result.reasons.length) lines.push("Reason unknown: no \"motivated by\" relation recorded. Evidence that something exists does not explain a decision.");
    for (const [label, edges] of [["Motivated by", result.reasons], ["Evidence", result.evidence], ["Alternatives", result.alternatives], ["Counterexamples / exceptions", result.counterexamples], ["Replaced by", result.replacements]] as const) {
      if (!edges.length) continue;
      lines.push(`\n${label}:`);
      for (const edge of edges) {
        const describe = (node: typeof edge.from) => `${node.id}${node.record && "state" in node.record ? ` [${node.record.state}${node.historical_version ? ", historical" : ""}${node.valid_at_query_time === false ? ", outside validity" : ""}]` : ""}: ${node.record?.content ?? "content unavailable"}`;
        lines.push(`- ${describe(edge.from)} → ${describe(edge.to)} [sources: ${edge.relation.source_ids.join(", ")}]`);
      }
    }
    if (result.cycles.length) lines.push("Cycle in the reasons; stopped at that cycle.");
    if (result.truncated) lines.push("Partial result: depth or relation limit reached.");
  } else if ("versions" in result && result.versions) {
    lines.push(`History: ${result.knowledge_id}`);
    for (const v of result.versions) lines.push(`- v${v.version} · ${v.state} · ${v.recorded_at} · ${v.id}\n  ${v.content} [sources: ${v.source_ids.join(", ")}]`);
    for (const event of result.events) lines.push(`  Event ${event.id}: ${event.content}`);
  }
  if ("sources" in result && result.sources) {
    lines.push("\nRecorded sources (provenance, not independent verification):");
    for (const source of result.sources) lines.push(`- ${source.id} · ${source.reference}${source.revision ? ` @ ${source.revision}` : ""}\n  ${source.content ?? "Content not kept; see the reference."}`);
  }
  return lines.join("\n");
}

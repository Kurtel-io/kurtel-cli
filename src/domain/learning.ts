export interface LearningEvent { id: string; role: "user" | "assistant" | "tool" | "system"; content: string }
/** space and date: a team's memory, and the day of the conversation (YYYY-MM-DD). */
export interface ExtractionRequest { protocol: 1; batch_id: string; session_id: string; events: LearningEvent[]; context_events: LearningEvent[]; space?: true; date?: string }
/** valid_from / valid_until (space only): first and last day the fact holds, both included, YYYY-MM-DD. */
export interface Candidate { event_id: string; quote: string; kind: string; zones: string[]; reason_event_id?: string | null; reason_quote?: string | null; valid_from?: string | null; valid_until?: string | null }
export interface WorkingItem { event_id: string; quote: string; category: "goal" | "constraint" | "finding" | "next_step" | "attempt" | "result" }
export interface ExtractionResponse { protocol: 1; batch_id: string; engine: string; candidates: Candidate[]; working: WorkingItem[] }

export const ENGINE_NAMES = ["claude-code", "codex"] as const;
export function isEngineName(v: string): boolean {
  return (ENGINE_NAMES as readonly string[]).includes(v);
}
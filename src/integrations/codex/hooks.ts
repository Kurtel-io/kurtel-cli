import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function quote(value: string) {
  // Hook commands pass through a shell. Reject expansion characters on Windows.
  if (process.platform === "win32") {
    if (/["%!`$\r\n]/.test(value)) throw new Error("Unsupported shell characters in Codex hook path");
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function planCodexHooks(root: string, enabled: boolean) {
  const path = join(root, ".codex", "hooks.json");
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error("Codex hooks must not be a symbolic link");
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = original ? JSON.parse(original) : {};
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Invalid Codex hooks configuration");
  const hooks = config.hooks ?? {};
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) throw new Error("Invalid Codex hooks configuration");
  const suffix = ` codex-capture --root ${quote(root)}`;
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) throw new Error(`Invalid Codex hook event: ${event}`);
    hooks[event] = groups.map(group => {
      if (!group || !Array.isArray(group.hooks)) throw new Error(`Invalid Codex hook group: ${event}`);
      const remaining = group.hooks.filter((hook: any) => !(hook.type === "command" && typeof hook.command === "string" && hook.command.endsWith(suffix)));
      if (remaining.length !== group.hooks.length) changed = true;
      return { ...group, hooks: remaining };
    }).filter(group => group.hooks.length);
    if (!hooks[event].length) delete hooks[event];
  }
  if (enabled) {
    const cli = fileURLToPath(new URL("../../index.js", import.meta.url));
    const command = `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} ${quote(cli)}${suffix}`;
    for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop", "SessionEnd", "Interrupt"]) {
      (hooks[event] ??= []).push({ hooks: [{ type: "command", command, timeout: event === "Interrupt" || event === "SessionEnd" ? 3 : 10 }] });
    }
    changed = true;
  }
  config.hooks = hooks;
  return { path, content: changed ? JSON.stringify(config, null, 2) + "\n" : original, changed };
}

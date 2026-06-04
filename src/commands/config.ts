import { c, symbols } from "../ui/colors.js";
import {
  loadConfig,
  setConfigValue,
  configPath,
} from "../lib/config.js";

export function configCommand(action?: string, key?: string, value?: string): void {
  if (!action || action === "list") {
    const config = loadConfig();
    console.log(`\n${c.dim("config")} ${c.dim(configPath())}\n`);
    for (const [k, v] of Object.entries(config)) {
      console.log(`${c.indigo(k.padEnd(14))} ${c.white(String(v))}`);
    }
    console.log("");
    return;
  }

  if (action === "get") {
    if (!key) {
      console.log(`${c.red(symbols.cross)} Usage: ${c.indigo("kurtel config get <key>")}`);
      process.exitCode = 1;
      return;
    }
    const config = loadConfig();
    console.log(String(config[key] ?? c.dim("(unset)")));
    return;
  }

  if (action === "set") {
    if (!key || value === undefined) {
      console.log(
        `${c.red(symbols.cross)} Usage: ${c.indigo("kurtel config set <key> <value>")}`
      );
      process.exitCode = 1;
      return;
    }
    setConfigValue(key, value);
    console.log(`${symbols.check} Set ${c.indigo(key)} = ${c.white(value)}`);
    return;
  }

  console.log(
    `${c.red(symbols.cross)} Unknown action ${c.white(action)}. Try ${c.indigo(
      "list"
    )}, ${c.indigo("get")}, or ${c.indigo("set")}.`
  );
  process.exitCode = 1;
}

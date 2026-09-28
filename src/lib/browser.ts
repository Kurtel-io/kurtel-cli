import { assertNetworkAllowed } from "../security/network.js";
import { spawn } from "node:child_process";

// Best-effort: open a URL in the default browser across macOS / Windows / Linux.
export function openBrowser(url: string): boolean {
  try {
    assertNetworkAllowed(url, "cloud");
    const platform = process.platform;
    let command: string;
    let args: string[];

    if (platform === "darwin") {
      command = "open";
      args = [url];
    } else if (platform === "win32") {
      command = "cmd";
      args = ["/c", "start", "", url];
    } else {
      command = "xdg-open";
      args = [url];
    }

    const child = spawn(command, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
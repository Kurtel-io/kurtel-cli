import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { loadConfig, saveSession, clearSession } from "../lib/config.js";
import { startDeviceAuth, pollDeviceAuth } from "../lib/api.js";
import { openBrowser } from "../lib/browser.js";

export async function loginCommand(): Promise<void> {
  const config = loadConfig();
  if (config.loggedIn && config.token) {
    console.log(
      `${symbols.check} Already signed in as ${c.indigo(
        config.account ?? "your account"
      )}${
        config.organization ? c.dim(` · ${config.organization}`) : ""
      }.`
    );
    console.log(`${c.dim("Run")} ${c.indigo("kurtel logout")} ${c.dim("to switch accounts.")}`);
    return;
  }

  // 1. Begin the device flow.
  let session;
  const startSpin = new Spinner("Requesting a device code…").start();
  try {
    session = await startDeviceAuth();
    startSpin.stop();
  } catch (e) {
    startSpin.fail(
      `Couldn't reach Kurtel: ${e instanceof Error ? e.message : String(e)}`
    );
    console.log(
      `${c.dim("Check your connection, or set")} ${c.indigo(
        "KURTEL_API_URL"
      )} ${c.dim("for local dev.")}`
    );
    process.exitCode = 1;
    return;
  }

  // 2. Show the URL + code, try to open the browser.
  console.log("");
  console.log(`${c.indigo(symbols.arrow)} Open this URL to authorize:`);
  console.log(`  ${c.bold(session.verification_url)}`);
  console.log("");
  console.log(`${c.dim("Device code:")} ${c.indigo(session.user_code)}`);
  console.log("");

  const opened = openBrowser(session.verification_url);
  if (opened) {
    console.log(c.dim("Opening your browser…"));
  }

  // 3. Poll until authorized / expired / timeout.
  const spin = new Spinner("Waiting for you to authorize in the browser…").start();
  const intervalMs = Math.max(1, session.interval) * 1000;
  const deadline = Date.now() + session.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    let res;
    try {
      res = await pollDeviceAuth(session.device_code);
    } catch {
      continue; // transient network error — keep polling
    }

    if (res.status === "authorized") {
      saveSession({
        token: res.token,
        account: res.account,
        organization: res.organization,
      });
      spin.succeed(
        `Signed in as ${c.indigo(res.account ?? "your account")}${
          res.organization ? c.dim(` · ${res.organization}`) : ""
        }`
      );
      console.log(c.dim("You can close the browser tab."));
      return;
    }

    if (res.status === "denied") {
      spin.fail("Authorization was denied.");
      process.exitCode = 1;
      return;
    }

    if (res.status === "expired" || res.status === "not_found" || res.status === "used") {
      spin.fail("This login request expired. Run `kurtel login` again.");
      process.exitCode = 1;
      return;
    }
    // status === "pending" → keep waiting
  }

  spin.fail("Timed out waiting for authorization. Run `kurtel login` again.");
  process.exitCode = 1;
}

export async function logoutCommand(): Promise<void> {
  const config = loadConfig();
  if (!config.loggedIn) {
    console.log(c.dim("You're not signed in."));
    return;
  }
  clearSession();
  console.log(`${symbols.check} Signed out.`);
}

export function whoamiCommand(): void {
  const config = loadConfig();
  if (!config.loggedIn || !config.token) {
    console.log(`${c.dim("Not signed in. Run")} ${c.indigo("kurtel login")}${c.dim(".")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`${c.indigo(symbols.info)} ${c.white(config.account ?? "unknown account")}`);
  if (config.organization) {
    console.log(`${c.gray("org")} ${c.white(config.organization)}`);
  }
}
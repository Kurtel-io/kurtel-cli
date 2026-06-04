import { c, symbols } from "../ui/colors.js";
import { Spinner, sleep } from "../ui/spinner.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { previewNotice } from "./_shared.js";

export async function loginCommand(): Promise<void> {
  const config = loadConfig();
  if (config.loggedIn) {
    console.log(
      `${symbols.check} Already signed in as ${c.indigo(
        config.account ?? "you@example.com"
      )}.`
    );
    return;
  }

  console.log("");
  console.log(
    `${c.indigo(symbols.arrow)} Sign in to Kurtel — we'll open your browser to authorize.`
  );
  const fakeUrl = "https://kurtel.ai/cli/auth?code=KRTL-PREVIEW";
  console.log(`  ${c.dim(fakeUrl)}`);
  console.log("");

  const spin = new Spinner("Waiting for browser authorization…").start();
  await sleep(1200);
  spin.info("Authorization step is a preview stub.");

  config.loggedIn = true;
  config.account = "you@example.com";
  saveConfig(config);

  console.log(
    `${symbols.check} Signed in as ${c.indigo(config.account)} ${c.dim(
      "(local preview session)"
    )}`
  );
  previewNotice("Authentication");
}

export async function logoutCommand(): Promise<void> {
  const config = loadConfig();
  if (!config.loggedIn) {
    console.log(`${c.dim("You're not signed in.")}`);
    return;
  }
  config.loggedIn = false;
  delete config.account;
  saveConfig(config);
  console.log(`${symbols.check} Signed out.`);
}

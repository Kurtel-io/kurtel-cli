import { repoRoot, repoFullName, memoryEnabled } from "../memory/store.js";
import { postLearnEvent } from "../memory/api.js";
import { learnFromCommit } from "../memory/learn.js";
import { c, symbols } from "../ui/colors.js";

// ── `kurtel learn-commit` (caché): appelé par le hook git post-commit ─────────
// Apprend le commit qui vient d'être créé. Silencieux, best effort, exit 0 toujours
// — un échec ne doit jamais polluer la sortie de `git commit`.
export async function learnCommitCommand(): Promise<void> {
  try {
    await learnFromCommit(repoRoot());
  } catch { /* jamais visible */ }
  process.exitCode = 0;
}

// ── `kurtel learn "<règle>"`: canal explicite ────────────────────────────────
// Le développeur énonce une règle directement (un interdit, une décision) que les
// commits ne révèlent pas. Elle entre en `origin:"explicit"` côté backend:
// confiance maximale, injectée à l'agent immédiatement, sans graduation.

export async function learnCommand(rule: string): Promise<void> {
  const root = repoRoot();
  const text = (rule ?? "").trim();

  if (text.length < 6) {
    console.log(
      `${c.yellow(symbols.warn)} ${c.dim("Provide a rule, e.g.")} ${c.indigo('kurtel learn "always validate the Origin header on POST routes"')}`
    );
    return;
  }
  if (!memoryEnabled(root)) {
    console.log(`${c.dim("Memory is off for this repo — run")} ${c.indigo("kurtel onboard")} ${c.dim("first.")}`);
    return;
  }

  const repo = repoFullName(root);
  try {
    const res = await postLearnEvent(repo, { source: "explicit", rules: [text] });
    if (res.skipped) {
      console.log(`${c.dim("Skipped:")} ${res.skipped}`);
    } else {
      console.log(`${symbols.check} Learned for ${c.white(repo)} ${c.dim("— injected to the agent from now on.")}`);
    }
  } catch (e) {
    console.log(`${c.yellow(symbols.warn)} ${c.dim((e as Error).message)}`);
  }
}

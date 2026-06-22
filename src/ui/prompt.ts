import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { c } from "./colors.js";

// Prompts interactifs minimaux (zéro dépendance, sur node:readline). Toujours
// gardés par isInteractive(): hors TTY (pipe, CI, terminal non-interactif), on
// NE prompte JAMAIS — l'appelant retombe sur des défauts pour ne pas bloquer.

/** Interactif seulement si stdin ET stdout sont des TTY. */
export function isInteractive(): boolean {
  return !!process.stdin.isTTY && !!process.stdout.isTTY;
}

/** Question texte libre avec valeur par défaut (Entrée = défaut). */
export async function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const hint = def ? ` ${c.dim(`(${def})`)}` : "";
    const answer = (await rl.question(`${c.indigo("?")} ${question}${hint} `)).trim();
    return answer || def || "";
  } finally {
    rl.close();
  }
}

/** Choix dans une liste numérotée. Renvoie la valeur choisie (défaut sur entrée vide). */
export async function select(
  question: string,
  choices: string[],
  defaultIndex = 0
): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    output.write(`${c.indigo("?")} ${question}\n`);
    choices.forEach((ch, i) => {
      const marker = i === defaultIndex ? c.indigo("›") : " ";
      output.write(`  ${marker} ${c.dim(String(i + 1))} ${ch}\n`);
    });
    const raw = (
      await rl.question(`  ${c.dim(`[1-${choices.length}, défaut ${defaultIndex + 1}]`)} `)
    ).trim();
    if (!raw) return choices[defaultIndex];
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return choices[n - 1];
    return choices[defaultIndex];
  } finally {
    rl.close();
  }
}

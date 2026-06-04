import { c, symbols } from "../ui/colors.js";

export function previewNotice(what: string): void {
  console.log(
    `${c.yellow(symbols.warn)} ${c.dim(
      `${what} isn't wired up to the Kurtel cloud yet — this is a preview build.`
    )}`
  );
}

export function heading(text: string): void {
  console.log(`\n${c.indigoBold(text)}`);
}

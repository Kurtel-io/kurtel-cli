import { c } from "./colors.js";

// Strip ANSI escapes to measure visible width.
function visibleLength(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export interface BoxOptions {
  padding?: number;
  borderColor?: (s: string | number) => string;
  title?: string;
}

export function box(lines: string[], opts: BoxOptions = {}): string {
  const padding = opts.padding ?? 1;
  const color = opts.borderColor ?? c.indigo;

  const contentWidth = Math.max(
    ...lines.map(visibleLength),
    opts.title ? visibleLength(opts.title) + 2 : 0
  );
  const innerWidth = contentWidth + padding * 2;

  const horizontal = "─".repeat(innerWidth);
  const top = opts.title
    ? color("╭─ ") + c.bold(opts.title) + color(" " + "─".repeat(Math.max(0, innerWidth - visibleLength(opts.title) - 3)) + "╮")
    : color("╭" + horizontal + "╮");
  const bottom = color("╰" + horizontal + "╯");

  const pad = " ".repeat(padding);
  const body = lines.map((line) => {
    const fill = " ".repeat(Math.max(0, contentWidth - visibleLength(line)));
    return color("│") + pad + line + fill + pad + color("│");
  });

  return [top, ...body, bottom].join("\n");
}

// Lightweight ANSI styling — no dependencies.
// Honors NO_COLOR and non-TTY output.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== "dumb" &&
  (process.stdout.isTTY ?? false);

function wrap(open: string, close = "\x1b[0m") {
  return (s: string | number) => (enabled ? `${open}${s}${close}` : String(s));
}

// Brand indigo (#6798ff) via 24-bit truecolor, with graceful no-op fallback.
const indigoOpen = "\x1b[38;2;103;152;255m";

export const c = {
  enabled,
  reset: "\x1b[0m",
  bold: wrap("\x1b[1m"),
  dim: wrap("\x1b[2m"),
  italic: wrap("\x1b[3m"),
  underline: wrap("\x1b[4m"),

  // brand
  indigo: wrap(indigoOpen),
  indigoBold: wrap(`\x1b[1m${indigoOpen}`),

  // neutrals / semantic
  white: wrap("\x1b[97m"),
  gray: wrap("\x1b[90m"),
  ash: wrap("\x1b[37m"),
  green: wrap("\x1b[32m"),
  yellow: wrap("\x1b[33m"),
  red: wrap("\x1b[31m"),
  cyan: wrap("\x1b[36m"),

  // background
  bgIndigo: wrap("\x1b[48;2;103;152;255m\x1b[30m"),
};

export const symbols = {
  dot: "·",
  arrow: "›",
  check: c.green("✔"),
  cross: c.red("✖"),
  warn: c.yellow("!"),
  info: c.indigo("●"),
  bullet: c.gray("•"),
  spinnerFrames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

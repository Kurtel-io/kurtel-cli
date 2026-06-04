import { c, symbols } from "./colors.js";

export class Spinner {
  private timer: NodeJS.Timeout | null = null;
  private frame = 0;
  private text: string;
  private active = false;

  constructor(text: string) {
    this.text = text;
  }

  start(): this {
    if (!process.stdout.isTTY) {
      process.stdout.write(`${c.indigo(symbols.info)} ${this.text}\n`);
      return this;
    }
    this.active = true;
    process.stdout.write("\x1b[?25l"); // hide cursor
    this.timer = setInterval(() => {
      const f = symbols.spinnerFrames[this.frame % symbols.spinnerFrames.length];
      process.stdout.write(`\r${c.indigo(f)} ${this.text}`);
      this.frame++;
    }, 80);
    return this;
  }

  update(text: string): void {
    this.text = text;
  }

  private clearLine() {
    if (this.active) process.stdout.write("\r\x1b[K");
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.clearLine();
    if (this.active) process.stdout.write("\x1b[?25h"); // show cursor
    this.active = false;
  }

  succeed(text?: string): void {
    this.stop();
    process.stdout.write(`${symbols.check} ${text ?? this.text}\n`);
  }

  fail(text?: string): void {
    this.stop();
    process.stdout.write(`${symbols.cross} ${text ?? this.text}\n`);
  }

  info(text?: string): void {
    this.stop();
    process.stdout.write(`${symbols.info} ${text ?? this.text}\n`);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

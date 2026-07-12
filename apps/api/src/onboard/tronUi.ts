import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// Hand-rolled ANSI 256 TUI in the TRON palette (cyan grid, magenta accents).
// No TUI deps: everything is escape codes + node:readline. Pure renderers are
// exported for tests; interactive helpers read from the real TTY.

const ESC = "[";
export const ansi = {
  reset: `${ESC}0m`,
  bold: `${ESC}1m`,
  dim: `${ESC}2m`,
  cyan: `${ESC}38;5;51m`,
  magenta: `${ESC}38;5;201m`,
  grid: `${ESC}38;5;37m`,
  amber: `${ESC}38;5;214m`,
  green: `${ESC}38;5;46m`,
  red: `${ESC}38;5;196m`
};

export function paint(color: string, text: string): string {
  return `${color}${text}${ansi.reset}`;
}

const BANNER_LINES = [
  "  ___ _  _ ___  _   _ ___ _____ _   ",
  " |_ _| \\| |   \\| | | / __|_   _/_\\  ",
  "  | || .` | |) | |_| \\__ \\ | |/ _ \\ ",
  " |___|_|\\_|___/ \\___/|___/ |_/_/ \\_\\",
  "     Q U O T E   S Y S T E M        "
];

/** Pure: the boot banner as a string (tested without a TTY). */
export function renderBanner(): string {
  const bar = "═".repeat(38);
  const top = paint(ansi.grid, `╔${bar}╗`);
  const bottom = paint(ansi.grid, `╚${bar}╝`);
  const body = BANNER_LINES.map((text, index) => {
    const color = index === BANNER_LINES.length - 1 ? ansi.magenta : ansi.cyan;
    return paint(ansi.grid, "║ ") + paint(ansi.bold + color, text.padEnd(36)) + paint(ansi.grid, "║");
  }).join("\n");
  return [top, body, bottom].join("\n");
}

export function section(title: string): string {
  return `\n${paint(ansi.magenta + ansi.bold, "▓▓")} ${paint(ansi.cyan + ansi.bold, title)}`;
}

export function line(text: string): void {
  stdout.write(`${text}\n`);
}

export function info(text: string): void {
  line(`${paint(ansi.grid, "│")} ${text}`);
}

export function ok(text: string): void {
  line(`${paint(ansi.green, "✓")} ${text}`);
}

export function warn(text: string): void {
  line(`${paint(ansi.amber, "!")} ${text}`);
}

export function fail(text: string): void {
  line(`${paint(ansi.red, "✗")} ${text}`);
}

/** Tron-style boot scanline. Best-effort: silent when not a TTY. */
export async function bootAnimation(delayMs = 34): Promise<void> {
  if (!stdout.isTTY) return;
  const width = Math.min(stdout.columns ?? 40, 40);
  for (let i = 0; i <= width; i += 2) {
    const filled = paint(ansi.cyan, "▰".repeat(i / 2));
    const empty = paint(ansi.dim, "▱".repeat((width - i) / 2));
    stdout.write(`\r${paint(ansi.magenta, "⟩")} ${filled}${empty}`);
    await sleep(delayMs);
  }
  stdout.write(`\r${" ".repeat(width + 4)}\r`);
}

export function createSpinner(label: string): { stop: (final?: string) => void } {
  if (!stdout.isTTY) {
    line(`${paint(ansi.dim, "…")} ${label}`);
    return { stop: (final) => final && ok(final) };
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  const timer = setInterval(() => {
    stdout.write(`\r${paint(ansi.cyan, frames[i % frames.length]!)} ${label}`);
    i += 1;
  }, 80);
  return {
    stop: (final) => {
      clearInterval(timer);
      stdout.write(`\r${" ".repeat(label.length + 4)}\r`);
      if (final) ok(final);
    }
  };
}

export async function ask(question: string, fallback = ""): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    const suffix = fallback ? paint(ansi.dim, ` [${fallback}]`) : "";
    const answer = (await rl.question(`${paint(ansi.cyan, "›")} ${question}${suffix} `)).trim();
    return answer || fallback;
  } finally {
    rl.close();
  }
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "S/n" : "s/N";
  const answer = (await ask(`${question} (${hint})`)).toLowerCase();
  if (!answer) return defaultYes;
  return answer.startsWith("s") || answer.startsWith("y");
}

export async function select(
  question: string,
  options: Array<{ value: string; label: string }>
): Promise<string> {
  line(section(question));
  options.forEach((option, index) => info(`${paint(ansi.magenta, String(index + 1))}) ${option.label}`));
  for (;;) {
    const raw = await ask("Elige una opción");
    const index = Number(raw) - 1;
    if (Number.isInteger(index) && index >= 0 && index < options.length) {
      return options[index]!.value;
    }
    const byValue = options.find((option) => option.value === raw);
    if (byValue) return byValue.value;
    warn("Opción inválida.");
  }
}

/**
 * Pure per-chunk consumer for masked input. A paste delivers the whole
 * secret (often with the trailing newline) as ONE data event, so we must
 * walk the chunk char by char instead of reading chunk[0].
 */
export function consumeMaskedInput(
  value: string,
  chunk: string
): { value: string; done: boolean } {
  for (const ch of chunk) {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 13 || code === 10) return { value, done: true };
    if (code === 127 || code === 8) {
      value = value.slice(0, -1);
      continue;
    }
    value += ch;
  }
  return { value, done: false };
}

/** Masked secret input via raw mode. Falls back to plain read without a TTY. */
export async function askMasked(question: string): Promise<string> {
  if (!stdin.isTTY) return ask(question);
  return new Promise<string>((resolve) => {
    stdout.write(`${paint(ansi.cyan, "›")} ${question} `);
    stdin.setRawMode(true);
    stdin.resume();
    let value = "";
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (text.includes("\u0003")) {
        stdin.setRawMode(false);
        process.exit(130);
      }
      const before = value.length;
      const result = consumeMaskedInput(value, text);
      value = result.value;
      if (value.length > before) {
        stdout.write(paint(ansi.dim, "•".repeat(value.length - before)));
      }
      if (result.done) {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        stdout.write("\n");
        resolve(value);
      }
    };
    stdin.on("data", onData);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The terminal progress bar the long-running scripts share.
 *
 * A run of `data:details` opens a few thousand profiles, `data:links` walks a
 * backlog of a few hundred records and `data:hololist` fetches 9,359 pages, so
 * "wait, is it doing anything?" is the normal state of the terminal for
 * minutes at a time. Each script used to answer that with a `log()` every 50
 * items — a wall of text that scrolls the useful line off the screen.
 *
 * The mechanics follow Nuxt's CLI (`nuxt/cli` →
 * `packages/nuxt-cli/src/utils/phase-reporter.ts`), which solves the same
 * problem for `nuxt dev`/`nuxt build`, and the three parts worth copying are:
 *
 * 1. **`styleText` from `node:util`.** No colour dependency: it emits escape
 *    codes only when the stream supports them and `NO_COLOR` is unset, so
 *    nothing here tests for colour. Nuxt's reporter imports it the same way.
 *
 * 2. **A tap on `stdout`.** Foreign output — a `log()`, a stack trace, a
 *    library's warning — written while the bar is up lands *inside* the bar's
 *    line, and the next redraw overwrites half of it. Rather than ask every
 *    call site to cooperate, `stream.write` is wrapped for as long as the bar
 *    lives: anything that is not the bar clears the line first. This is
 *    Nuxt's `tapOutput()`, and it is why `logLine()` below is now just a
 *    `console.log`.
 *
 * 3. **A TTY is not a CI log.** `\r` redraws one line on a terminal; in a
 *    GitHub Actions log it is a single line that grows for forty minutes and
 *    is unreadable in a browser. Nuxt's `isAnimationSupported()` is
 *    `isTTY && !CI && !NO_COLOR`, and the same test decides here whether the
 *    bar animates or prints one plain line per step.
 *
 * Two things are deliberately different. Nuxt's line is a spinner and a label,
 * because a build's phases have no known length; a data run does have a count,
 * so the bar keeps the percentage, the count, the rate and an ETA beside the
 * spinner. And the spinner keeps turning between ticks, so a slow request still
 * looks alive.
 */

import { styleText } from "node:util";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const FRAME_INTERVAL = 80;
/** Carriage return, then erase the whole line — `\r\x1b[K` leaves fragments. */
const CLEAR_LINE = "\r\u001B[2K";

/** A `styleText()` call that degrades to plain text if colour is off. */
function paint(format: string | string[], text: string): string {
  try {
    return styleText(format as never, text);
  } catch {
    /* An unsupported format, or an old Node — plain text is fine. */
    return text;
  }
}

/**
 * Whether the line may animate.
 *
 * `CI` is checked as well as the TTY: a runner can allocate a pseudo-terminal,
 * and a `\r`-redrawn line in a captured log is worse than no bar at all.
 */
export function isAnimationSupported(stream: NodeJS.WriteStream = process.stdout): boolean {
  return Boolean(stream.isTTY) && !process.env.CI && !process.env.NO_COLOR;
}

/**
 * Runs `onWrite` before anything else writes to `stream`, until disposed.
 *
 * The bar's own writes go through `write()` so they do not clear themselves.
 * Restoring the original `write` is not optional — the process may outlive the
 * bar, and a leaked wrapper would clear a line that no longer exists.
 */
function tapOutput(
  stream: NodeJS.WriteStream,
  onWrite: () => void,
): { write: (chunk: string) => void; dispose: () => void } {
  const original = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  let ours = false;

  stream.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!ours) onWrite();
    return original(chunk, ...rest);
  }) as NodeJS.WriteStream["write"];

  return {
    write(chunk: string) {
      ours = true;
      try {
        original(chunk);
      } finally {
        ours = false;
      }
    },
    dispose() {
      stream.write = original as NodeJS.WriteStream["write"];
    },
  };
}

export interface ProgressBar {
  /** Advance by one and redraw (throttled). */
  tick(detail?: string): void;
  /** Set the absolute count and redraw (throttled). */
  update(value: number, detail?: string): void;
  /**
   * Correct the total mid-run.
   *
   * The sync pipeline decides its phase count up front and then discovers a
   * phase it can skip (`--limit-live`), so the bar has to be told — otherwise
   * a finished run stops at 97 % and looks truncated.
   */
  setTotal(total: number): void;
  /** Finish: clear the line and print the summary. */
  done(message?: string): void;
  /** Finish as a failure. The run continues; only the line is red. */
  fail(message?: string): void;
}

interface ProgressOptions {
  /** What is being counted, for the summary line. Defaults to `items`. */
  unit?: string;
  /** How often the line may repaint. Defaults to 100 ms. */
  intervalMs?: number;
  /** Show a rate and an ETA. Defaults to true once 8 items are in. */
  eta?: boolean;
}

/**
 * The bar currently drawing.
 *
 * One at a time is deliberate: two bars on one line is a rendering problem
 * with no good answer, and no script here needs two.
 */
let active: { clear(): void } | null = null;

/**
 * Prints a line while a bar is up.
 *
 * Kept as a named function because the tap already clears the line for any
 * `stdout` write — so this is a `console.log` with a place to explain why it
 * is safe, rather than a second mechanism. `console.log` writes through the
 * tapped stream, which is the whole point of the tap.
 */
export function logLine(message: string): void {
  console.log(message);
}

/** `1,234` — a count a person can read at a glance. */
function group(value: number): string {
  return value.toLocaleString("en-US");
}

/** `1m 02s` — an ETA, rounded to something a human plans around. */
function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return `${minutes}m ${String(rest).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A progress bar for `total` items.
 *
 * `total` may be 0 when the count is not known up front; the bar then shows
 * the count and the rate without a percentage, which is honest about what is
 * known.
 */
export function progressBar(
  label: string,
  initialTotal: number,
  options: ProgressOptions = {},
): ProgressBar {
  const stream = process.stdout;
  const unit = options.unit ?? "items";
  const intervalMs = options.intervalMs ?? 100;
  const showEta = options.eta ?? true;
  const animated = isAnimationSupported(stream);
  const startedAt = Date.now();

  let total = initialTotal;
  let value = 0;
  let detail = "";
  let lastPaint = 0;
  let lastNonTtyPercent = -1;
  let finished = false;

  /* --- animation state ------------------------------------------------ */
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  let dirty = false;
  /** The text last painted, so a frame that only moves the spinner is cheap. */
  let painted: string | undefined;

  const tap = animated ? tapOutput(stream, () => clear()) : undefined;
  const write = tap ? tap.write : (chunk: string) => void stream.write(chunk);

  function clear(): void {
    if (!animated || !dirty) return;
    write(CLEAR_LINE);
    dirty = false;
    painted = undefined;
  }

  /** The text after the spinner: count, rate, ETA, what is being fetched. */
  function describe(): string {
    const count = total > 0 ? `${group(value)}/${group(total)}` : group(value);
    const elapsed = Date.now() - startedAt;
    const perSecond = elapsed > 0 ? (value / elapsed) * 1000 : 0;
    const enough = value >= 8 && elapsed >= 1000;
    const rate = enough ? `${perSecond.toFixed(1)}/s` : "";
    const eta =
      showEta && enough && total > value && perSecond > 0
        ? `ETA ${duration(((total - value) / perSecond) * 1000)}`
        : "";
    return [count, rate, eta, detail].filter(Boolean).join("  ·  ");
  }

  function percent(): number | null {
    return total > 0 ? Math.min(100, Math.round((value / total) * 100)) : null;
  }

  /** The line as it should read right now, styled for a terminal. */
  function line(): string {
    const pct = percent();
    const cells = 15;
    const filled = pct === null ? 0 : Math.round((pct / 100) * cells);
    /* `styleText("green", "")` still emits a pair of escapes — skip the fill
       until there is something to fill. */
    const bar =
      (filled > 0 ? paint("green", "▇".repeat(filled)) : "") +
      (filled < cells ? paint("gray", "░".repeat(cells - filled)) : "");
    const badge =
      pct === null
        ? paint("dim", "  ?% ")
        : paint("bold", ` ${String(pct).padStart(3)}% `);
    const head = `${paint("bold", label)} ${bar}${badge}`;

    /* Escape codes occupy no columns, so measure the plain form and pad that. */
    const plainHead = `${label} ${"▇".repeat(filled)}${"░".repeat(cells - filled)} ${
      pct === null ? "  ?% " : ` ${String(pct).padStart(3)}% `
    }`;
    const room = Math.max(40, stream.columns ?? 80) - plainHead.length - 4;
    const body = describe();
    return `${head} ${paint("dim", body.length > room ? `${body.slice(0, Math.max(0, room - 1))}…` : body)}`;
  }

  function render(): void {
    if (finished) return;
    if (!animated) {
      /* A log cannot redraw: one plain line per 5 %, and no more than 10 s apart. */
      const pct = percent() ?? 0;
      if (pct === lastNonTtyPercent && Date.now() - lastPaint < 10_000) return;
      lastNonTtyPercent = pct;
      lastPaint = Date.now();
      const badge = percent() === null ? "" : `  ${String(percent()).padStart(3)}%`;
      stream.write(`${label}${badge}  ${describe()}\n`);
      return;
    }

    const glyph = paint("cyan", FRAMES[(frame = (frame + 1) % FRAMES.length)]!);
    const text = line();
    /* Most frames only move the spinner; rewriting the rest for that is waste. */
    if (dirty && text === painted) {
      write(`\r${glyph}`);
      return;
    }
    clear();
    write(`${glyph} ${text}`);
    painted = text;
    dirty = true;
    lastPaint = Date.now();
  }

  function animate(): void {
    if (!animated || timer) return;
    timer = setInterval(render, FRAME_INTERVAL);
    timer.unref?.();
  }

  /** Take the line down and leave the terminal as it was found. */
  function restore(): void {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    clear();
    tap?.dispose();
  }

  function shouldPaint(): boolean {
    return Date.now() - lastPaint >= intervalMs;
  }

  const bar: ProgressBar = {
    tick(next?: string) {
      value += 1;
      if (next !== undefined) detail = next;
      if (shouldPaint()) render();
    },
    update(next: number, nextDetail?: string) {
      value = next;
      if (nextDetail !== undefined) detail = nextDetail;
      if (shouldPaint()) render();
    },
    setTotal(next: number) {
      total = next;
      render();
    },
    done(message?: string) {
      if (finished) return;
      finished = true;
      active = null;
      restore();
      const summary = message ?? `${group(value)} ${unit}`;
      const elapsed = duration(Date.now() - startedAt);
      console.log(`${paint("green", "✔")} ${paint("bold", label)} — ${summary} · ${elapsed}`);
    },
    fail(message?: string) {
      if (finished) return;
      finished = true;
      active = null;
      restore();
      console.log(`${paint("red", "✖")} ${paint("bold", label)} — ${message ?? "stopped"}`);
    },
  };

  active = { clear };
  if (animated) animate();
  render();
  return bar;
}

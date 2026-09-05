// Bound retained OSC text independently of terminal scrollback.
const MAX_OSC_LENGTH = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// oxlint-disable-next-line no-control-regex -- C0 bytes are handled by the outer VT parser.
const oscControl = /[\x00-\x1f]/g;

/** Shares one serialized writer per client, with at most one pending clipboard payload. */
export function createTerminalClipboardWriter(
  writeText: (text: string) => Promise<unknown> | undefined,
) {
  // OSC writers share one system clipboard. Retain only the newest pending copy
  // while a clipboard write is in flight, so slow permission checks cannot build a backlog.
  let writingClipboard = false;
  let pendingClipboardWrite: {
    text: string;
    canWrite: () => boolean;
    resolve: () => void;
  } | null = null;

  function writeTerminalClipboard(
    text: string,
    canWrite: () => boolean = () => true,
  ): Promise<void> {
    return new Promise((resolve) => {
      pendingClipboardWrite?.resolve();
      pendingClipboardWrite = { text, canWrite, resolve };
      if (!writingClipboard) void drainClipboardWrites();
    });
  }

  async function drainClipboardWrites(): Promise<void> {
    writingClipboard = true;
    while (pendingClipboardWrite) {
      const request = pendingClipboardWrite;
      pendingClipboardWrite = null;
      try {
        if (request.canWrite()) await writeText(request.text);
      } catch {
        // Clipboard failures must not write errors into the TUI or block later copies.
      }
      request.resolve();
    }
    writingClipboard = false;
  }
  return writeTerminalClipboard;
}

function decodeClipboardPayload(osc: string): string | null {
  if (!osc.startsWith("52;")) return null;
  const separator = osc.indexOf(";", 3);
  if (separator === -1) return null;
  const target = osc.slice(3, separator);
  // Empty targets use the system clipboard. Queries never read or send the
  // client's clipboard to a PTY; application selection buffers stay local.
  if (target !== "" && (!/^[cpqs0-7]+$/.test(target) || !target.includes("c"))) return null;
  const encoded = osc.slice(separator + 1);
  if (encoded === "") return "";
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  try {
    return decoder.decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Observes 7-bit OSC framing in live output independently of native renderer replays. */
export class TerminalClipboardParser {
  private state: "ground" | "escape" | "osc" | "oscEscape" = "ground";
  // Null means this sequence has no clipboard payload worth retaining.
  private payload: string | null = null;
  private eligible = false;
  private escapeEligible = false;

  private readonly onWrite: (text: string) => void;

  constructor(onWrite: (text: string) => void) {
    this.onWrite = onWrite;
  }

  reset(): void {
    this.state = "ground";
    this.invalidatePendingCopy();
  }

  /** Revokes a pending copy on focus/visibility loss without losing VT framing. */
  invalidatePendingCopy(): void {
    this.payload = null;
    this.eligible = false;
    this.escapeEligible = false;
  }

  private beginEscape(eligible: boolean): void {
    this.state = "escape";
    this.payload = null;
    this.eligible = eligible;
  }

  /** Ineligible chunks still advance parsing, so replay cannot become a live copy. */
  write(data: string, eligible: boolean): void {
    if (!eligible) this.invalidatePendingCopy();
    for (let index = 0; index < data.length; index += 1) {
      const char = data[index]!;
      if (char === "\x18" || char === "\x1a") {
        this.reset();
        continue;
      }
      switch (this.state) {
        case "ground": {
          // ESC also exits DCS/APC/PM/SOS, so their payloads need no separate state.
          const escape = data.indexOf("\x1b", index);
          if (escape === -1) return;
          index = escape;
          this.beginEscape(eligible);
          break;
        }
        case "escape":
          if (char === "]") {
            this.state = "osc";
            this.payload = this.eligible ? "" : null;
          } else if (char === "\x1b") {
            this.beginEscape(eligible);
          } else if (char >= " " && char !== "\x7f") {
            this.state = "ground";
          }
          break;
        case "osc":
          if (char === "\x07") {
            this.finish();
          } else if (char === "\x1b") {
            this.state = "oscEscape";
            this.escapeEligible = eligible;
          } else if (char < " ") {
            // Ghostty ignores other C0 bytes inside OSC, including wrapped lines.
          } else {
            oscControl.lastIndex = index;
            const control = oscControl.exec(data);
            const length = (control?.index ?? data.length) - index;
            if (this.payload !== null) {
              if (this.payload.length + length <= MAX_OSC_LENGTH) {
                this.payload += data.slice(index, index + length);
                if (!"52;".startsWith(this.payload.slice(0, 3))) this.payload = null;
              } else {
                this.payload = null;
              }
            }
            index += length - 1;
          }
          break;
        case "oscEscape":
          if (char === "\\") {
            this.finish();
          } else {
            // An ESC other than ST aborts the OSC and starts a new escape.
            this.beginEscape(this.escapeEligible);
            index -= 1;
          }
          break;
      }
    }
  }

  private finish(): void {
    const text =
      this.eligible && this.payload !== null ? decodeClipboardPayload(this.payload) : null;
    this.reset();
    if (text !== null) this.onWrite(text);
  }
}

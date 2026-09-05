import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { TerminalClipboardParser, writeTerminalClipboard } from "./clipboard";

function osc(text: string, target = "c", terminator = "\x07") {
  return `\x1b]52;${target};${Buffer.from(text).toString("base64")}${terminator}`;
}

describe("terminal OSC 52 clipboard writes", () => {
  it.each(["\uFEFFtext", "\uFEFF"])("preserves leading U+FEFF in %j", (text) => {
    const copy = vi.fn();
    new TerminalClipboardParser(copy).write(osc(text), true);
    expect(copy.mock.calls).toEqual([[text]]);
  });

  it.each(["\x07", "\x1b\\"])(
    "decodes Unicode with terminator %j at every chunk boundary",
    (end) => {
      const text = "Claude: café 界🙂\nsecond line";
      const data = `prompt${osc(text, "c", end)}tail`;
      for (let split = 0; split <= data.length; split += 1) {
        const copy = vi.fn();
        const parser = new TerminalClipboardParser(copy);
        parser.write(data.slice(0, split), true);
        parser.write(data.slice(split), true);
        expect(copy.mock.calls).toEqual([[text]]);
      }
    },
  );

  it("handles single-character chunks and multiple writes", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    for (const char of osc("one") + osc("two", "", "\x1b\\")) parser.write(char, true);
    expect(copy.mock.calls).toEqual([["one"], ["two"]]);
  });

  it.each([
    "\x1b]52;c;?\x07",
    "\x1b]52;c;\x07",
    "\x1b]52;c;bad!\x07",
    "\x1b]52;c;/w==\x07",
    osc("primary", "p"),
    "\x1b]0;title\x07",
  ])("ignores unsupported or malformed request %j and recovers", (data) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(data + osc("valid"), true);
    expect(copy.mock.calls).toEqual([["valid"]]);
  });

  it("does not complete an ineligible request after focus returns", () => {
    const data = osc("historical");
    for (let split = 1; split < data.length; split += 1) {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(data.slice(0, split), false);
      parser.write(data.slice(split) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    }
  });

  it("drops requests that become ineligible before completion", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;", true);
    parser.write("YQ==", false);
    parser.write("\x07", true);
    expect(copy).not.toHaveBeenCalled();
  });

  it.each(["P", "_", "^", "X"])("exits %s strings on ESC before parsing OSC", (type) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(`\x1b${type}${osc("embedded")}\x1b\\${osc("live")}`, true);
    expect(copy.mock.calls).toEqual([["embedded"], ["live"]]);
  });

  it.each(["\x1b]0;unfinished", "\x1b]52;c;YQ==\u009c", "\x1bPtmux;\x1b"])(
    "recovers the first complete request after %j at every chunk boundary",
    (prefix) => {
      const data = prefix + osc("next") + "\x1b\\" + osc("last");
      for (let split = 0; split <= data.length; split += 1) {
        const copy = vi.fn();
        const parser = new TerminalClipboardParser(copy);
        parser.write(data.slice(0, split), true);
        parser.write(data.slice(split), true);
        expect(copy.mock.calls).toEqual([["next"], ["last"]]);
      }
    },
  );

  it.each(["\x1b]0;unfinished", "\x1bPq", "\x1b_ignored"])(
    "does not replay an OSC escape split across focus changes after %j",
    (prefix) => {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(prefix + "\x1b", false);
      parser.write(osc("historical").slice(1) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
      copy.mockClear();
      parser.reset();
      parser.write(prefix, false);
      parser.write(osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    },
  );

  it.each(["\n", "\r\n", "\t"])("ignores C0 controls %j in wrapped payloads", (separator) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    const text = "long clipboard text ".repeat(20);
    const encoded = Buffer.from(text)
      .toString("base64")
      .replace(/(.{76})/g, `$1${separator}`);
    parser.write(`\x1b]52;c;${encoded}\x07`, true);
    expect(copy.mock.calls).toEqual([[text]]);
  });

  it.each(["c", "cp", "pc", "s0c", "7c"])("writes clipboard target list %j", (target) => {
    const copy = vi.fn();
    new TerminalClipboardParser(copy).write(osc("text", target), true);
    expect(copy.mock.calls).toEqual([["text"]]);
  });

  it.each(["\x18", "\x1a", "\x1b[0m"])("recovers from aborted OSC with %j", (cancel) => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write(`\x1b]52;c;YQ==${cancel}\x07${osc("live")}`, true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it("bounds unfinished clipboard data and recovers after the terminator", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;", true);
    const chunk = "YWFh".repeat(16_384);
    for (let index = 0; index < 17; index += 1) parser.write(chunk, true);
    parser.write("\x07" + osc("live"), true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it("drops incomplete requests on reset", () => {
    const copy = vi.fn();
    const parser = new TerminalClipboardParser(copy);
    parser.write("\x1b]52;c;YQ==", true);
    parser.reset();
    parser.write("\x07" + osc("live"), true);
    expect(copy.mock.calls).toEqual([["live"]]);
  });

  it.each(["\x07", "\x1b\\"])("invalidates a pending copy without losing framing for %j", (end) => {
    const data = osc("old", "c", end);
    for (let split = 1; split < data.length; split += 1) {
      const copy = vi.fn();
      const parser = new TerminalClipboardParser(copy);
      parser.write(data.slice(0, split), true);
      parser.invalidatePendingCopy();
      parser.write(data.slice(split) + osc("live"), true);
      expect(copy.mock.calls).toEqual([["live"]]);
    }
  });
});

describe("application clipboard writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["success", "denied"])(
    "serializes writes and keeps only the newest pending text after %s",
    async (result) => {
      let finishFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      let clipboard = "";
      const writeText = vi.fn(async (text: string) => {
        if (text === "first") {
          await first;
          if (result === "denied") throw new Error("NotAllowedError");
        }
        clipboard = text;
      });
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const writes = [
        writeTerminalClipboard("first"),
        writeTerminalClipboard("superseded"),
        writeTerminalClipboard("last"),
      ];
      const callsWhilePending = [...writeText.mock.calls];
      finishFirst();
      await Promise.all(writes);
      expect(callsWhilePending).toEqual([["first"]]);
      expect(writeText.mock.calls).toEqual([["first"], ["last"]]);
      expect(clipboard).toBe("last");
    },
  );

  it.each(["success", "denied", "unavailable"])(
    "keeps browser focus and consumes failures when clipboard access is %s",
    async (result) => {
      const writeText = vi.fn(() =>
        result === "denied" ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(),
      );
      const createElement = vi.fn();
      const execCommand = vi.fn();
      vi.stubGlobal("navigator", result === "unavailable" ? {} : { clipboard: { writeText } });
      vi.stubGlobal("document", { createElement, execCommand });
      await expect(writeTerminalClipboard("application text")).resolves.toBeUndefined();
      expect(writeText.mock.calls).toEqual(result === "unavailable" ? [] : [["application text"]]);
      expect(createElement).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    },
  );
});

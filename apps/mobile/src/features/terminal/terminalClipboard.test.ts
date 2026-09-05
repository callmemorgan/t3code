import { describe, expect, it, vi } from "vite-plus/test";
import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";
import {
  applyTerminalAttachStreamEvent,
  EMPTY_TERMINAL_BUFFER_STATE,
} from "@t3tools/client-runtime/state/terminal";
import { ThreadId } from "@t3tools/contracts";
import { createTerminalClipboardSession } from "./terminalClipboard";

const osc = (text: string) => `\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`;

function harness(writeText = vi.fn(async (_text: string) => {})) {
  const write = createTerminalClipboardWriter(writeText);
  const pending: Promise<unknown>[] = [];
  const session = createTerminalClipboardSession((text, canWrite) => {
    const result = write(text, canWrite);
    pending.push(result);
    return result;
  });
  let state = EMPTY_TERMINAL_BUFFER_STATE;
  return {
    session,
    writeText,
    flush: () => Promise.all(pending),
    update: () => session.update(state.output),
    append(data: string) {
      state = applyTerminalAttachStreamEvent(state, {
        type: "output",
        threadId: ThreadId.make("thread"),
        terminalId: "terminal",
        data,
      });
      session.update(state.output);
    },
    reset() {
      state = {
        ...state,
        output: { ...state.output, resetVersion: state.output.resetVersion + 1 },
      };
      session.update(state.output);
    },
  };
}

describe("mobile terminal clipboard session", () => {
  it("copies live Unicode output once while ignoring initial history and replay", async () => {
    const h = harness();
    h.session.setActive(true);
    h.append(osc("history"));
    const text = "\uFEFFClaude: café 界🙂";
    const data = osc(text);
    h.append(data.slice(0, -1));
    h.append(data.slice(-1));
    h.update();
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text]]);
    h.reset();
    h.append(osc("new"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text], ["new"]]);
  });

  it("does not finish a split copy across leaving and returning to the terminal", async () => {
    const h = harness();
    h.update();
    h.session.setActive(true);
    h.append(osc("old").slice(0, -1));
    h.session.setActive(false);
    h.session.setActive(true);
    h.append("\x07" + osc("live"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["live"]]);
  });

  it("ignores background output without losing stream framing", async () => {
    const h = harness();
    h.update();
    h.append(osc("background").slice(0, -1));
    h.session.setActive(true);
    h.append("\x07" + osc("live"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["live"]]);
  });

  it.each(["deactivate", "reset"])("revokes queued native writes on %s", async (action) => {
    let finish!: () => void;
    const first = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const h = harness(vi.fn(() => first));
    h.update();
    h.session.setActive(true);
    h.append(osc("first") + osc("queued"));
    if (action === "reset") h.reset();
    else h.session.setActive(false);
    h.session.setActive(true);
    finish();
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["first"]]);
    h.append(osc("current"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([["first"], ["current"]]);
  });
});

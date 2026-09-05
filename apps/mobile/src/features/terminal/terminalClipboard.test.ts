import { describe, expect, it, vi } from "vite-plus/test";
import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";
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
  const target = { threadId: ThreadId.make("thread"), terminalId: "terminal" };
  return {
    session,
    writeText,
    flush: () => Promise.all(pending),
    history(history: string) {
      session.update({
        type: "snapshot",
        snapshot: {
          ...target,
          cwd: "/tmp",
          worktreePath: null,
          status: "running",
          pid: 1,
          history,
          exitCode: null,
          exitSignal: null,
          label: "Terminal 1",
          updatedAt: "2026-09-05T00:00:00Z",
        },
      });
    },
    append(data: string) {
      session.update({ type: "output", ...target, data });
    },
    reset() {
      session.update({ type: "cleared", ...target });
    },
  };
}

describe("mobile terminal clipboard session", () => {
  it("copies live Unicode output once while ignoring initial history and replay", async () => {
    const h = harness();
    h.session.setActive(true);
    h.history(osc("history"));
    const text = "\uFEFFClaude: café 界🙂";
    const data = osc(text);
    h.append(data.slice(0, -1));
    h.append(data.slice(-1));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text]]);
    h.reset();
    h.append(osc("new"));
    await h.flush();
    expect(h.writeText.mock.calls).toEqual([[text], ["new"]]);
  });

  it.each(["single", "chunks"])(
    "copies a payload larger than retained output in %s writes",
    async (mode) => {
      const h = harness();
      h.session.setActive(true);
      const text = "x".repeat(600 * 1024);
      const data = osc(text);
      if (mode === "single") h.append(data);
      else
        for (let index = 0; index < data.length; index += 16 * 1024)
          h.append(data.slice(index, index + 16 * 1024));
      h.append("later output".repeat(100_000));
      await h.flush();
      expect(h.writeText.mock.calls).toEqual([[text]]);
    },
  );

  it("does not finish a split copy across leaving and returning to the terminal", async () => {
    const h = harness();
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

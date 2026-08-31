import { describe, expect, it } from "vite-plus/test";

import { resolveTerminalOpenContext } from "./terminalOpenContext";

describe("resolveTerminalOpenContext", () => {
  it.each([
    {
      source: "terminal UI adapter",
      input: {
        terminalUiOpen: true,
        activeBottomPanelKind: null,
        activeRightPanelKind: null,
      },
    },
    {
      source: "bottom panel terminal",
      input: {
        terminalUiOpen: false,
        activeBottomPanelKind: "terminal-adapter" as const,
        activeRightPanelKind: null,
      },
    },
    {
      source: "right panel terminal",
      input: {
        terminalUiOpen: false,
        activeBottomPanelKind: null,
        activeRightPanelKind: "terminal" as const,
      },
    },
  ])("reports the terminal open from the $source", ({ input }) => {
    expect(resolveTerminalOpenContext(input)).toBe(true);
  });

  it("does not treat other active panel surfaces as terminals", () => {
    expect(
      resolveTerminalOpenContext({
        terminalUiOpen: false,
        activeBottomPanelKind: "files",
        activeRightPanelKind: "diff",
      }),
    ).toBe(false);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it.each([
    {
      location: "bottom" as const,
      label: "Toggle bottom terminal",
      iconClass: "lucide-panel-bottom",
    },
    {
      location: "right" as const,
      label: "Toggle terminal in right panel",
      iconClass: "lucide-panel-right",
    },
  ])("shows the $location destination and keeps its pressed state", (testCase) => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        terminalAvailable
        terminalLocation={testCase.location}
        terminalOpen
        terminalShortcutLabel="⌘J"
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    const terminalButton = markup.match(
      new RegExp(`<button[^>]*aria-label="${testCase.label}"[^>]*>[\\s\\S]*?</button>`),
    )?.[0];

    expect(terminalButton).toBeDefined();
    expect(terminalButton).toContain(testCase.iconClass);
    expect(terminalButton).toContain('aria-pressed="true"');
  });

  it("keeps unavailable panel tooltip triggers interactive", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        terminalAvailable={false}
        terminalLocation="right"
        terminalOpen={false}
        terminalShortcutLabel={null}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(2);
    expect(markup.match(/data-slot="tooltip-trigger"[^>]*><button[^>]*disabled=""/g)).toHaveLength(
      2,
    );
  });
});

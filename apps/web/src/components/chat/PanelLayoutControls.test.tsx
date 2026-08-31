import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { PanelLayoutControls } from "./PanelLayoutControls";

describe("PanelLayoutControls", () => {
  it.each([
    {
      location: "bottom" as const,
      label: "Toggle terminal in bottom panel",
    },
    {
      location: "right" as const,
      label: "Toggle terminal in right panel",
    },
  ])("shows the $location destination and keeps its pressed state", (testCase) => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        terminalAvailable
        terminalLocation={testCase.location}
        terminalOpen
        terminalShortcutLabel="⌘J"
        bottomPanelAvailable
        bottomPanelOpen={false}
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleBottomPanel={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    const terminalButton = markup.match(
      new RegExp(`<button[^>]*aria-label="${testCase.label}"[^>]*>[\\s\\S]*?</button>`),
    )?.[0];

    expect(terminalButton).toBeDefined();
    expect(terminalButton).toContain("lucide-terminal");
    expect(terminalButton).toContain('aria-pressed="true"');
  });

  it("keeps terminal, bottom panel, and right panel state independent", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        terminalAvailable
        terminalLocation="bottom"
        terminalOpen={false}
        terminalShortcutLabel={null}
        bottomPanelAvailable
        bottomPanelOpen
        rightPanelAvailable
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleBottomPanel={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    const terminalButton = markup.match(
      /<button[^>]*aria-label="Toggle terminal in bottom panel"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    const bottomPanelButton = markup.match(
      /<button[^>]*aria-label="Toggle bottom panel"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];
    const rightPanelButton = markup.match(
      /<button[^>]*aria-label="Toggle right panel"[^>]*>[\s\S]*?<\/button>/,
    )?.[0];

    expect(terminalButton).toContain("lucide-terminal");
    expect(terminalButton).toContain('aria-pressed="false"');
    expect(bottomPanelButton).toContain("lucide-panel-bottom");
    expect(bottomPanelButton).toContain('aria-pressed="true"');
    expect(rightPanelButton).toContain("lucide-panel-right");
    expect(rightPanelButton).toContain('aria-pressed="false"');
    expect(markup.indexOf('aria-label="Toggle terminal in bottom panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle bottom panel"'),
    );
    expect(markup.indexOf('aria-label="Toggle bottom panel"')).toBeLessThan(
      markup.indexOf('aria-label="Toggle right panel"'),
    );
  });

  it("keeps unavailable panel tooltip triggers interactive", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl
        terminalAvailable={false}
        terminalLocation="right"
        terminalOpen={false}
        terminalShortcutLabel={null}
        bottomPanelAvailable={false}
        bottomPanelOpen={false}
        rightPanelAvailable={false}
        rightPanelOpen={false}
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleBottomPanel={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(3);
    expect(markup.match(/data-slot="tooltip-trigger"[^>]*><button[^>]*disabled=""/g)).toHaveLength(
      3,
    );
  });

  it("can keep non-chat routes limited to the right panel control", () => {
    const markup = renderToStaticMarkup(
      <PanelLayoutControls
        showTerminalControl={false}
        showBottomPanelControl={false}
        terminalAvailable={false}
        terminalOpen={false}
        terminalShortcutLabel={null}
        bottomPanelAvailable={false}
        bottomPanelOpen={false}
        rightPanelAvailable
        rightPanelOpen
        rightPanelShortcutLabel={null}
        liveAgentCount={0}
        onToggleTerminal={() => {}}
        onToggleBottomPanel={() => {}}
        onToggleRightPanel={() => {}}
      />,
    );

    expect(markup.match(/data-slot="tooltip-trigger"/g)).toHaveLength(1);
    expect(markup).not.toContain("lucide-terminal");
    expect(markup).not.toContain("lucide-panel-bottom");
    expect(markup).toContain("lucide-panel-right");
  });
});

import type { BottomPanelSurface, RightPanelKind } from "./rightPanelStore";

export function resolveTerminalOpenContext(input: {
  terminalUiOpen: boolean;
  activeBottomPanelKind: BottomPanelSurface["kind"] | null;
  activeRightPanelKind: RightPanelKind | null;
}): boolean {
  return (
    input.terminalUiOpen ||
    input.activeBottomPanelKind === "terminal-adapter" ||
    input.activeRightPanelKind === "terminal"
  );
}

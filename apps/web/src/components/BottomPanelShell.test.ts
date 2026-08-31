import { describe, expect, it } from "vite-plus/test";

import {
  clampBottomPanelHeight,
  maxBottomPanelHeight,
  MIN_BOTTOM_PANEL_HEIGHT,
} from "./BottomPanelShell";

describe("BottomPanelShell height", () => {
  it("uses the same 75% viewport ceiling as the terminal drawer", () => {
    expect(maxBottomPanelHeight(1_000)).toBe(750);
    expect(clampBottomPanelHeight(900, 1_000)).toBe(750);
  });

  it("keeps the panel usable in short windows", () => {
    expect(maxBottomPanelHeight(200)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
    expect(clampBottomPanelHeight(40, 200)).toBe(MIN_BOTTOM_PANEL_HEIGHT);
  });

  it("rounds valid heights and falls back from invalid values", () => {
    expect(clampBottomPanelHeight(321.6, 1_000)).toBe(322);
    expect(clampBottomPanelHeight(Number.NaN, 1_000)).toBe(280);
  });
});

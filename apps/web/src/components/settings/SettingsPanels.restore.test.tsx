import type { ReactElement } from "react";
import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const settingsState = vi.hoisted(() => ({
  value: null as UnifiedSettings | null,
  updateSettings: vi.fn(),
}));

const themeState = vi.hoisted(() => ({
  confirm: vi.fn(),
  setTheme: vi.fn(() => true),
  setFollowSystem: vi.fn(() => true),
  setThemeHalf: vi.fn(() => true),
  clearThemeHalves: vi.fn(() => true),
}));

const atomValues = vi.hoisted(() => ({
  queue: [] as unknown[],
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
    useRef: reactHookHarness.useRef,
    useState: reactHookHarness.useState,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => atomValues.queue.shift(),
}));

vi.mock("../../hooks/useSettings", () => ({
  usePrimarySettings: () => settingsState.value,
  useUpdatePrimarySettings: () => settingsState.updateSettings,
}));

vi.mock("../../hooks/useTheme", () => ({
  readAppearanceModePreference: () => "system",
  readThemeHalves: () => null,
  readThemePreference: () => "system",
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: themeState.setTheme,
    setFollowSystem: themeState.setFollowSystem,
    setThemeHalf: themeState.setThemeHalf,
    clearThemeHalves: themeState.clearThemeHalves,
  }),
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({ dialogs: { confirm: themeState.confirm } }),
  readLocalApi: () => ({ dialogs: { confirm: themeState.confirm } }),
}));

import { GeneralSettingsPanel, useSettingsRestore } from "./SettingsPanels";

function renderGeneralSettings(): ReactElement<Record<string, unknown>> {
  hooks.beginRender();
  atomValues.queue = [null, []];
  return GeneralSettingsPanel() as ReactElement<Record<string, unknown>>;
}

describe("terminal open-location reset", () => {
  beforeEach(() => {
    hooks.reset();
    settingsState.value = {
      ...DEFAULT_UNIFIED_SETTINGS,
      terminalOpenLocation: "right",
    };
    settingsState.updateSettings.mockReset();
    themeState.confirm.mockReset().mockResolvedValue(true);
  });

  it("resets the General setting to the bottom panel default", () => {
    const panel = renderGeneralSettings();
    const terminalRow = visitElements(
      panel,
      (element) => element.props.id === "terminal-open-location",
    );
    const resetButton = visitElements(
      terminalRow?.props.resetAction,
      (element) => element.props.label === "terminal open location",
    );

    expect(resetButton).not.toBeNull();
    (resetButton?.props.onClick as (() => void) | undefined)?.();

    expect(settingsState.updateSettings).toHaveBeenCalledWith({
      terminalOpenLocation: DEFAULT_UNIFIED_SETTINGS.terminalOpenLocation,
    });
  });

  it("includes the setting when restoring all defaults", async () => {
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual(["Terminal opens in"]);

    await restore.restoreDefaults();

    expect(themeState.confirm).toHaveBeenCalledWith(
      "Restore default settings?\nThis will reset: Terminal opens in.",
      { variant: "destructive" },
    );
    expect(settingsState.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        terminalOpenLocation: DEFAULT_UNIFIED_SETTINGS.terminalOpenLocation,
      }),
    );
  });
});

import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewOpenInput,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  resetPreviewStateForTests,
} from "~/previewStateStore";
import {
  selectThreadBottomPanelState,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "~/rightPanelStore";

import { addBrowserSurface } from "./addBrowserSurface";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const snapshot = (tabId: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: `2026-06-18T19:00:0${tabId.at(-1) ?? "0"}.000Z`,
});

beforeEach(() => {
  resetPreviewStateForTests();
  useRightPanelStore.setState({ byThreadKey: {}, bottomByThreadKey: {} });
});

describe("addBrowserSurface", () => {
  it("creates another preview session when a browser tab is already active", async () => {
    const first = snapshot("tab-1");
    const second = snapshot("tab-2");
    applyPreviewServerSnapshot(threadRef, first);
    useRightPanelStore.getState().openBrowser(threadRef, first.tabId);
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(second));

    await addBrowserSurface({ threadRef, openPreview: ({ input }) => openPreview(input) });

    expect(openPreview).toHaveBeenCalledWith({
      threadId: "thread-1",
      viewport: FILL_PREVIEW_VIEWPORT,
    });
    expect(Object.keys(readThreadPreviewState(threadRef).sessions)).toEqual(["tab-1", "tab-2"]);
    expect(
      selectThreadRightPanelState(
        useRightPanelStore.getState().byThreadKey,
        threadRef,
      ).surfaces.map((surface) => surface.id),
    ).toEqual(["browser:tab-1", "browser:tab-2"]);
  });

  it("opens a bottom browser only in the bottom panel", async () => {
    const created = snapshot("tab-bottom");
    const openPreview = vi.fn(async (_input: PreviewOpenInput) => AsyncResult.success(created));
    useRightPanelStore.getState().openBottomTerminal(threadRef);
    const beforePanelOpen = vi.fn(() => {
      expect(
        selectThreadBottomPanelState(useRightPanelStore.getState().bottomByThreadKey, threadRef)
          .activeSurfaceId,
      ).toBe("bottom:terminal");
    });

    await addBrowserSurface({
      threadRef,
      openPreview: ({ input }) => openPreview(input),
      location: "bottom",
      beforePanelOpen,
    });

    expect(beforePanelOpen).toHaveBeenCalledOnce();
    expect(
      selectThreadBottomPanelState(useRightPanelStore.getState().bottomByThreadKey, threadRef),
    ).toMatchObject({
      isOpen: true,
      activeSurfaceId: "browser:tab-bottom",
      surfaces: [
        { id: "bottom:terminal", kind: "terminal-adapter" },
        { id: "browser:tab-bottom", kind: "preview", resourceId: "tab-bottom" },
      ],
    });
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces,
    ).toEqual([]);
  });

  it("keeps the current panel active when creating a browser fails", async () => {
    const beforePanelOpen = vi.fn();
    useRightPanelStore.getState().openBottomTerminal(threadRef);

    const result = await addBrowserSurface({
      threadRef,
      openPreview: async () => AsyncResult.failure(Cause.fail(new Error("preview failed"))),
      location: "bottom",
      beforePanelOpen,
    });

    expect(result._tag).toBe("Failure");
    expect(beforePanelOpen).not.toHaveBeenCalled();
    expect(
      selectThreadBottomPanelState(useRightPanelStore.getState().bottomByThreadKey, threadRef)
        .activeSurfaceId,
    ).toBe("bottom:terminal");
  });
});

/**
 * Thread-scoped workspace panel state.
 *
 * This is intentionally a shallow workspace model: it owns an ordered set of
 * surface descriptors and the active surface, while each feature continues to
 * own its durable resource state. Browser surfaces point at preview tab ids,
 * right-panel terminal surfaces point at terminal session ids, file surfaces
 * point at workspace paths, and diff/files remain singleton surfaces. The
 * bottom terminal adapter points at terminalUiStateStore instead of duplicating
 * that store's terminal groups here.
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export type PanelLocation = "right" | "bottom";

export const RIGHT_PANEL_KINDS = [
  "diff",
  "files",
  "file",
  "preview",
  "terminal",
  "pull-request",
  "agents",
] as const;
export type RightPanelKind = (typeof RIGHT_PANEL_KINDS)[number];

export type RightPanelSurface =
  | { id: `browser:${string}`; kind: "preview"; resourceId: string }
  | { id: "browser:new"; kind: "preview"; resourceId: null }
  | {
      id: `terminal:${string}`;
      kind: "terminal";
      resourceId: string;
      terminalIds: string[];
      activeTerminalId: string;
      splitDirection?: "horizontal" | "vertical";
    }
  | { id: "diff"; kind: "diff" }
  | { id: "files"; kind: "files" }
  | {
      id: `file:${string}`;
      kind: "file";
      relativePath: string;
      revealLine: number | null;
      revealRequestId: number;
    }
  | {
      /**
       * A change request opened beside a thread or in the pull-request list's shared panel.
       * The reference lives in the id so several pull requests can remain open as peer tabs.
       */
      id: `pull-request:${string}`;
      kind: "pull-request";
      /**
       * Which server the change request was read from. The list spans every connected one, so
       * two of them can hold the same project id; a panel beside a thread leaves this out and
       * takes the environment from its own ref.
       */
      environmentId?: string;
      projectId: string;
      repository: string;
      number: number;
    }
  | { id: "agents"; kind: "agents" };

export const BOTTOM_PANEL_TERMINAL_SURFACE_ID = "bottom:terminal" as const;

/** Stable tab descriptor whose terminal groups continue to live in terminalUiStateStore. */
export type BottomPanelTerminalSurface = {
  id: typeof BOTTOM_PANEL_TERMINAL_SURFACE_ID;
  kind: "terminal-adapter";
};

export const BOTTOM_PANEL_TERMINAL_SURFACE: BottomPanelTerminalSurface = Object.freeze({
  id: BOTTOM_PANEL_TERMINAL_SURFACE_ID,
  kind: "terminal-adapter",
});

export type PanelSurface = RightPanelSurface | BottomPanelTerminalSurface;
export type BottomPanelSurface =
  | Exclude<RightPanelSurface, { kind: "terminal" }>
  | BottomPanelTerminalSurface;

const RIGHT_PANEL_STORAGE_KEY = "t3code:right-panel-state:v2";
// v9 removed the "plan" surface kind (plans render inline in the transcript).
// v10 keys pull-request surfaces by reference instead of a singleton tab.
// v11 stops persisting the pull-request list's shared panel, so a restart opens the page fresh.
// v12 adds a bottom panel alongside the existing right-panel state.
const RIGHT_PANEL_STORAGE_VERSION = 12;

/**
 * The pull-request list's shared panel (see PULL_REQUESTS_PANEL_ID in the route) is session
 * state: reopening the app should show the list, not last session's tabs and detail fetches.
 */
const isPullRequestsPanelKey = (threadKey: string) => threadKey.endsWith(":pull-requests-panel");

export interface ThreadPanelState<Surface extends PanelSurface = PanelSurface> {
  isOpen: boolean;
  activeSurfaceId: string | null;
  surfaces: Surface[];
}

export type ThreadRightPanelState = ThreadPanelState<RightPanelSurface>;
export type ThreadBottomPanelState = ThreadPanelState<BottomPanelSurface>;

export interface PanelStateCollections {
  byThreadKey: Record<string, ThreadRightPanelState>;
  bottomByThreadKey: Record<string, ThreadBottomPanelState>;
}

interface RightPanelStoreState {
  byThreadKey: Record<string, ThreadRightPanelState>;
  bottomByThreadKey: Record<string, ThreadBottomPanelState>;
  open: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  openAt: (
    ref: ScopedThreadRef,
    location: PanelLocation,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  openBrowser: (ref: ScopedThreadRef, tabId: string | null) => void;
  openBrowserAt: (ref: ScopedThreadRef, location: PanelLocation, tabId: string | null) => void;
  openFile: (ref: ScopedThreadRef, relativePath: string, line?: number) => void;
  openFileAt: (
    ref: ScopedThreadRef,
    location: PanelLocation,
    relativePath: string,
    line?: number,
  ) => void;
  openPullRequest: (
    ref: ScopedThreadRef,
    target: { environmentId?: string; projectId: string; repository: string; number: number },
  ) => void;
  openPullRequestAt: (
    ref: ScopedThreadRef,
    location: PanelLocation,
    target: { environmentId?: string; projectId: string; repository: string; number: number },
  ) => void;
  openBottomTerminal: (ref: ScopedThreadRef) => void;
  openTerminal: (ref: ScopedThreadRef, terminalId: string) => void;
  splitTerminal: (
    ref: ScopedThreadRef,
    surfaceId: string,
    terminalId: string,
    direction?: "horizontal" | "vertical",
  ) => void;
  activateTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  closeTerminal: (ref: ScopedThreadRef, surfaceId: string, terminalId: string) => void;
  activateSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  activateSurfaceAt: (ref: ScopedThreadRef, location: PanelLocation, surfaceId: string) => void;
  closeSurface: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfaceAt: (ref: ScopedThreadRef, location: PanelLocation, surfaceId: string) => void;
  closeOtherSurfaces: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeOtherSurfacesAt: (ref: ScopedThreadRef, location: PanelLocation, surfaceId: string) => void;
  closeSurfacesToRight: (ref: ScopedThreadRef, surfaceId: string) => void;
  closeSurfacesToRightAt: (
    ref: ScopedThreadRef,
    location: PanelLocation,
    surfaceId: string,
  ) => void;
  closeAllSurfaces: (ref: ScopedThreadRef) => void;
  closeAllSurfacesAt: (ref: ScopedThreadRef, location: PanelLocation) => void;
  reconcileBrowserSurfaces: (ref: ScopedThreadRef, tabIds: readonly string[]) => void;
  reconcileFileSurfaces: (ref: ScopedThreadRef, workspaceAvailable: boolean) => void;
  show: (ref: ScopedThreadRef) => void;
  showAt: (ref: ScopedThreadRef, location: PanelLocation) => void;
  close: (ref: ScopedThreadRef) => void;
  closeAt: (ref: ScopedThreadRef, location: PanelLocation) => void;
  toggleVisibility: (ref: ScopedThreadRef) => void;
  toggleVisibilityAt: (ref: ScopedThreadRef, location: PanelLocation) => void;
  toggle: (
    ref: ScopedThreadRef,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  toggleAt: (
    ref: ScopedThreadRef,
    location: PanelLocation,
    kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
  ) => void;
  removeThread: (ref: ScopedThreadRef) => void;
}

const EMPTY_THREAD_STATE: ThreadPanelState<never> = {
  isOpen: false,
  activeSurfaceId: null,
  surfaces: [],
};

const singletonSurface = (
  kind: Exclude<RightPanelKind, "file" | "preview" | "terminal" | "pull-request">,
): RightPanelSurface => {
  switch (kind) {
    case "diff":
      return { id: "diff", kind };
    case "files":
      return { id: "files", kind };
    case "agents":
      return { id: "agents", kind };
  }
};

const browserSurface = (tabId: string | null): RightPanelSurface =>
  tabId
    ? { id: `browser:${tabId}`, kind: "preview", resourceId: tabId }
    : { id: "browser:new", kind: "preview", resourceId: null };

const fileSurface = (
  relativePath: string,
  revealLine: number | null,
  revealRequestId: number,
): RightPanelSurface => ({
  id: `file:${relativePath}`,
  kind: "file",
  relativePath,
  revealLine,
  revealRequestId,
});

const terminalSurface = (terminalId: string): RightPanelSurface => ({
  id: `terminal:${terminalId}`,
  kind: "terminal",
  resourceId: terminalId,
  terminalIds: [terminalId],
  activeTerminalId: terminalId,
});

export type PullRequestSurface = Extract<RightPanelSurface, { kind: "pull-request" }>;

export function pullRequestSurfaceId(target: {
  environmentId?: string;
  projectId: string;
  repository: string;
  number: number;
}): PullRequestSurface["id"] {
  // The environment leads the id where there is one, so the same change request read from two
  // servers is two tabs rather than one tab that changes its mind about which server it is on.
  const scope =
    target.environmentId === undefined ? "" : `${encodeURIComponent(target.environmentId)}:`;
  return `pull-request:${scope}${encodeURIComponent(target.projectId)}:${encodeURIComponent(target.repository)}:${target.number}`;
}

export function pullRequestSurface(target: {
  environmentId?: string;
  projectId: string;
  repository: string;
  number: number;
}): PullRequestSurface {
  return {
    id: pullRequestSurfaceId(target),
    kind: "pull-request",
    ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
    projectId: target.projectId,
    repository: target.repository,
    number: target.number,
  };
}

/**
 * A pull-request tab's status map with one entry set. Keyed by the surface the panel is showing
 * rather than by a key rebuilt from the status, so the tab is found again whether or not that
 * surface was opened with an environment on it. Returns the same map when the tab's own fields
 * have not changed, so a caller can skip a re-render.
 */
export function updatePullRequestTabStatus<Status extends { state: unknown; isDraft: boolean }>(
  statuses: Readonly<Record<string, Status>>,
  surfaceId: string,
  status: Status,
): Readonly<Record<string, Status>> {
  return statuses[surfaceId]?.state === status.state &&
    statuses[surfaceId]?.isDraft === status.isDraft
    ? statuses
    : { ...statuses, [surfaceId]: status };
}

const upsertSurface = <Surface extends PanelSurface>(
  current: ThreadPanelState<Surface>,
  surface: Surface,
  activate = true,
): ThreadPanelState<Surface> => ({
  isOpen: true,
  surfaces: current.surfaces.some((entry) => entry.id === surface.id)
    ? current.surfaces
    : [...current.surfaces, surface],
  activeSurfaceId: activate ? surface.id : current.activeSurfaceId,
});

const updateThread = <Surface extends PanelSurface>(
  byThreadKey: Record<string, ThreadPanelState<Surface>>,
  threadKey: string,
  updater: (current: ThreadPanelState<Surface>) => ThreadPanelState<Surface>,
): Record<string, ThreadPanelState<Surface>> => {
  const current = byThreadKey[threadKey] ?? (EMPTY_THREAD_STATE as ThreadPanelState<Surface>);
  const next = updater(current);
  if (!next.isOpen && next.activeSurfaceId === null && next.surfaces.length === 0) {
    if (!(threadKey in byThreadKey)) return byThreadKey;
    const { [threadKey]: _removed, ...rest } = byThreadKey;
    return rest;
  }
  if (next === current) return byThreadKey;
  return { ...byThreadKey, [threadKey]: next };
};

function removeSurfaceFromThread<Surface extends PanelSurface>(
  current: ThreadPanelState<Surface>,
  surfaceId: string,
): ThreadPanelState<Surface> {
  const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (index < 0) return current;
  const surfaces = current.surfaces.filter((surface) => surface.id !== surfaceId);
  if (current.activeSurfaceId !== surfaceId) {
    return { ...current, isOpen: surfaces.length > 0 && current.isOpen, surfaces };
  }
  const fallback = surfaces[Math.min(index, surfaces.length - 1)] ?? null;
  return {
    ...current,
    isOpen: surfaces.length > 0 && current.isOpen,
    surfaces,
    activeSurfaceId: fallback?.id ?? null,
  };
}

function panelMapForLocation(
  state: PanelStateCollections,
  location: PanelLocation,
): Record<string, ThreadPanelState> {
  return location === "right" ? state.byThreadKey : state.bottomByThreadKey;
}

function oppositePanelLocation(location: PanelLocation): PanelLocation {
  return location === "right" ? "bottom" : "right";
}

function isExclusivePanelSurface(surface: PanelSurface): boolean {
  return surface.kind !== "terminal" && surface.kind !== "terminal-adapter";
}

function updatePanelAt(
  state: PanelStateCollections,
  threadKey: string,
  location: PanelLocation,
  updater: (current: ThreadPanelState) => ThreadPanelState,
  exclusiveSurfaceId?: string,
): PanelStateCollections {
  const targetMap = panelMapForLocation(state, location);
  const nextTargetMap = updateThread(targetMap, threadKey, updater);
  const otherLocation = oppositePanelLocation(location);
  const otherMap = panelMapForLocation(state, otherLocation);
  const nextOtherMap = exclusiveSurfaceId
    ? updateThread(otherMap, threadKey, (current) =>
        removeSurfaceFromThread(current, exclusiveSurfaceId),
      )
    : otherMap;

  return location === "right"
    ? {
        byThreadKey: nextTargetMap as Record<string, ThreadRightPanelState>,
        bottomByThreadKey: nextOtherMap as Record<string, ThreadBottomPanelState>,
      }
    : {
        byThreadKey: nextOtherMap as Record<string, ThreadRightPanelState>,
        bottomByThreadKey: nextTargetMap as Record<string, ThreadBottomPanelState>,
      };
}

function upsertPanelSurfaceAt(
  state: PanelStateCollections,
  threadKey: string,
  location: PanelLocation,
  surface: PanelSurface,
  prepare: (current: ThreadPanelState) => ThreadPanelState = (current) => current,
): PanelStateCollections {
  return updatePanelAt(
    state,
    threadKey,
    location,
    (current) => upsertSurface(prepare(current), surface),
    isExclusivePanelSurface(surface) ? surface.id : undefined,
  );
}

function normalizeRevealLine(line: number | undefined): number | null {
  if (line === undefined || !Number.isFinite(line)) return null;
  return Math.max(1, Math.trunc(line));
}

function migratePersistedPanelMap(
  persistedMap: unknown,
  options: { terminalSurfaces: boolean; terminalAdapter: boolean },
): Record<string, ThreadPanelState> {
  if (!persistedMap || typeof persistedMap !== "object") return {};
  return Object.fromEntries(
    Object.entries(persistedMap as Record<string, ThreadPanelState>)
      .filter(([threadKey]) => !isPullRequestsPanelKey(threadKey))
      .map(([threadKey, threadState]) => {
        const validThreadState =
          threadState && typeof threadState === "object" ? threadState : null;
        const surfaces = Array.isArray(validThreadState?.surfaces)
          ? validThreadState.surfaces.flatMap<PanelSurface>((surface) => {
              // Dropped surface kind: plans now render inline in the transcript (v9).
              if ((surface as { kind?: string }).kind === "plan") return [];
              if ((surface as { kind?: string }).kind === "terminal-adapter") {
                return options.terminalAdapter &&
                  (surface as { id?: string }).id === BOTTOM_PANEL_TERMINAL_SURFACE_ID
                  ? [BOTTOM_PANEL_TERMINAL_SURFACE]
                  : [];
              }
              if (surface.kind === "file") {
                const revealLine =
                  typeof surface.revealLine === "number" && Number.isFinite(surface.revealLine)
                    ? Math.max(1, Math.trunc(surface.revealLine))
                    : null;
                const revealRequestId =
                  typeof surface.revealRequestId === "number" &&
                  Number.isSafeInteger(surface.revealRequestId) &&
                  surface.revealRequestId >= 0
                    ? surface.revealRequestId
                    : 0;
                return [{ ...surface, revealLine, revealRequestId }];
              }
              if (surface.kind === "pull-request") {
                if (
                  typeof surface.projectId !== "string" ||
                  typeof surface.repository !== "string" ||
                  typeof surface.number !== "number" ||
                  !Number.isSafeInteger(surface.number) ||
                  surface.number < 1
                ) {
                  return [];
                }
                const { environmentId, ...rest } = surface;
                // Anything else stored under that name is not an environment.
                return [
                  pullRequestSurface({
                    ...rest,
                    ...(typeof environmentId === "string" ? { environmentId } : {}),
                  }),
                ];
              }
              if (surface.kind !== "terminal") return [surface];
              if (
                !options.terminalSurfaces ||
                !("resourceId" in surface) ||
                typeof surface.resourceId !== "string" ||
                surface.id !== `terminal:${surface.resourceId}`
              ) {
                return [];
              }
              const terminalIds =
                "terminalIds" in surface && Array.isArray(surface.terminalIds)
                  ? [
                      ...new Set(
                        surface.terminalIds.filter(
                          (terminalId): terminalId is string => typeof terminalId === "string",
                        ),
                      ),
                    ]
                  : [surface.resourceId];
              const activeTerminalId =
                "activeTerminalId" in surface &&
                typeof surface.activeTerminalId === "string" &&
                terminalIds.includes(surface.activeTerminalId)
                  ? surface.activeTerminalId
                  : (terminalIds[0] ?? surface.resourceId);
              return [
                {
                  ...surface,
                  terminalIds: terminalIds.length > 0 ? terminalIds : [surface.resourceId],
                  activeTerminalId,
                },
              ];
            })
          : [];
        const rawActiveSurfaceId = validThreadState?.activeSurfaceId;
        const persistedActiveSurfaceId = surfaces.some(
          (surface) => surface.id === rawActiveSurfaceId,
        )
          ? (rawActiveSurfaceId ?? null)
          : rawActiveSurfaceId === "pull-request"
            ? (surfaces.find((surface) => surface.kind === "pull-request")?.id ?? null)
            : null;
        // A migration that dropped every surface (e.g. plan-only panels in v9)
        // must not reopen an empty panel.
        const isOpen =
          surfaces.length > 0 &&
          (typeof validThreadState?.isOpen === "boolean"
            ? validThreadState.isOpen
            : persistedActiveSurfaceId !== null);
        // An open panel needs an active surface: if migration dropped the
        // persisted one, fall back to the first survivor.
        const activeSurfaceId =
          persistedActiveSurfaceId ?? (isOpen ? (surfaces[0]?.id ?? null) : null);
        return [threadKey, { isOpen, surfaces, activeSurfaceId }];
      }),
  );
}

function removePersistedCrossPanelDuplicates(
  byThreadKey: Record<string, ThreadRightPanelState>,
  bottomByThreadKey: Record<string, ThreadBottomPanelState>,
): Record<string, ThreadRightPanelState> {
  let next = byThreadKey;
  for (const [threadKey, bottomState] of Object.entries(bottomByThreadKey)) {
    const bottomIds = new Set(
      bottomState.surfaces.filter(isExclusivePanelSurface).map((surface) => surface.id),
    );
    if (bottomIds.size === 0) continue;
    next = updateThread(next, threadKey, (rightState) => {
      let current = rightState;
      for (const surfaceId of bottomIds) {
        current = removeSurfaceFromThread(current, surfaceId);
      }
      return current;
    });
  }
  return next;
}

export function migratePersistedRightPanelState(persistedState: unknown): PanelStateCollections {
  if (!persistedState || typeof persistedState !== "object") {
    return { byThreadKey: {}, bottomByThreadKey: {} };
  }
  const candidate = persistedState as {
    byThreadKey?: unknown;
    bottomByThreadKey?: unknown;
  };
  const bottomByThreadKey = migratePersistedPanelMap(candidate.bottomByThreadKey, {
    terminalSurfaces: false,
    terminalAdapter: true,
  }) as Record<string, ThreadBottomPanelState>;
  const byThreadKey = removePersistedCrossPanelDuplicates(
    migratePersistedPanelMap(candidate.byThreadKey, {
      terminalSurfaces: true,
      terminalAdapter: false,
    }) as Record<string, ThreadRightPanelState>,
    bottomByThreadKey,
  );
  return { byThreadKey, bottomByThreadKey };
}

function openKindInPanel(
  current: ThreadPanelState,
  kind: Exclude<RightPanelKind, "file" | "terminal" | "pull-request">,
): { state: ThreadPanelState; surface: RightPanelSurface } {
  if (kind === "preview") {
    const existing = current.surfaces.find(
      (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
        surface.kind === "preview",
    );
    const surface = existing ?? browserSurface(null);
    return { state: upsertSurface(current, surface), surface };
  }
  const surface = singletonSurface(kind);
  return { state: upsertSurface(current, surface), surface };
}

function openFileInPanel(
  current: ThreadPanelState,
  relativePath: string,
  line: number | undefined,
  previousRevealRequestId: number,
): ThreadPanelState {
  const withoutStandaloneExplorer = current.surfaces.filter((surface) => surface.kind !== "files");
  const surfaceId = `file:${relativePath}` as const;
  const existing = withoutStandaloneExplorer.find(
    (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
      surface.id === surfaceId && surface.kind === "file",
  );
  const surface = fileSurface(
    relativePath,
    normalizeRevealLine(line),
    Math.max(existing?.revealRequestId ?? 0, previousRevealRequestId) + 1,
  );
  return {
    isOpen: true,
    activeSurfaceId: surface.id,
    surfaces: existing
      ? withoutStandaloneExplorer.map((entry) => (entry.id === surface.id ? surface : entry))
      : [...withoutStandaloneExplorer, surface],
  };
}

function closeOtherPanelSurfaces(current: ThreadPanelState, surfaceId: string): ThreadPanelState {
  const surface = current.surfaces.find((entry) => entry.id === surfaceId);
  if (!surface || current.surfaces.length === 1) return current;
  return {
    ...current,
    isOpen: true,
    surfaces: [surface],
    activeSurfaceId: surface.id,
  };
}

function closePanelSurfacesToRight(current: ThreadPanelState, surfaceId: string): ThreadPanelState {
  const index = current.surfaces.findIndex((surface) => surface.id === surfaceId);
  if (index < 0 || index === current.surfaces.length - 1) return current;
  const surfaces = current.surfaces.slice(0, index + 1);
  const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
  return {
    ...current,
    surfaces,
    activeSurfaceId: activeStillExists ? current.activeSurfaceId : surfaceId,
  };
}

function reconcilePanelBrowserSurfaces<Surface extends PanelSurface>(
  current: ThreadPanelState<Surface>,
  validIds: ReadonlySet<string>,
  added: readonly Surface[] = [],
): ThreadPanelState<Surface> {
  const nonBrowser = current.surfaces.filter((surface) => surface.kind !== "preview");
  const existingBrowser = current.surfaces.filter(
    (surface) =>
      surface.kind === "preview" && surface.id !== "browser:new" && validIds.has(surface.id),
  );
  const surfaces = [...nonBrowser, ...existingBrowser, ...added];
  const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
  const fallbackBrowser = surfaces.find((surface) => surface.kind === "preview");
  return {
    ...current,
    surfaces,
    activeSurfaceId: activeStillExists
      ? current.activeSurfaceId
      : (fallbackBrowser?.id ?? surfaces[0]?.id ?? null),
  };
}

function reconcilePanelFileSurfaces<Surface extends PanelSurface>(
  current: ThreadPanelState<Surface>,
  workspaceAvailable: boolean,
): ThreadPanelState<Surface> {
  if (workspaceAvailable) return current;
  const surfaces = current.surfaces.filter(
    (surface) => surface.kind !== "files" && surface.kind !== "file",
  );
  if (surfaces.length === current.surfaces.length) return current;
  const activeStillExists = surfaces.some((surface) => surface.id === current.activeSurfaceId);
  return {
    ...current,
    isOpen: surfaces.length > 0 ? current.isOpen : false,
    surfaces,
    activeSurfaceId: activeStillExists ? current.activeSurfaceId : (surfaces.at(-1)?.id ?? null),
  };
}

export const useRightPanelStore = create<RightPanelStoreState>()(
  persist(
    (set, get) => ({
      byThreadKey: {},
      bottomByThreadKey: {},
      open: (ref, kind) => get().openAt(ref, "right", kind),
      openAt: (ref, location, kind) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const current = panelMapForLocation(state, location)[threadKey] ?? EMPTY_THREAD_STATE;
          const { surface } = openKindInPanel(current, kind);
          return upsertPanelSurfaceAt(state, threadKey, location, surface);
        }),
      openBrowser: (ref, tabId) => get().openBrowserAt(ref, "right", tabId),
      openBrowserAt: (ref, location, tabId) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const surface = browserSurface(tabId);
          return upsertPanelSurfaceAt(state, threadKey, location, surface, (current) => ({
            ...current,
            surfaces: tabId
              ? current.surfaces.filter((entry) => entry.id !== "browser:new")
              : current.surfaces,
          }));
        }),
      openPullRequest: (ref, target) => get().openPullRequestAt(ref, "right", target),
      openPullRequestAt: (ref, location, target) =>
        set((state) =>
          upsertPanelSurfaceAt(state, scopedThreadKey(ref), location, pullRequestSurface(target)),
        ),
      openFile: (ref, relativePath, line) => get().openFileAt(ref, "right", relativePath, line),
      openFileAt: (ref, location, relativePath, line) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const surfaceId = `file:${relativePath}`;
          const previousRevealRequestId = Math.max(
            ...(["right", "bottom"] as const).map((candidateLocation) => {
              const candidate = panelMapForLocation(state, candidateLocation)[
                threadKey
              ]?.surfaces.find(
                (surface): surface is Extract<RightPanelSurface, { kind: "file" }> =>
                  surface.id === surfaceId && surface.kind === "file",
              );
              return candidate?.revealRequestId ?? 0;
            }),
          );
          return updatePanelAt(
            state,
            threadKey,
            location,
            (current) => openFileInPanel(current, relativePath, line, previousRevealRequestId),
            surfaceId,
          );
        }),
      openBottomTerminal: (ref) =>
        set((state) =>
          upsertPanelSurfaceAt(
            state,
            scopedThreadKey(ref),
            "bottom",
            BOTTOM_PANEL_TERMINAL_SURFACE,
          ),
        ),
      openTerminal: (ref, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) =>
            upsertSurface(current, terminalSurface(terminalId)),
          ),
        })),
      splitTerminal: (ref, surfaceId, terminalId, direction = "horizontal") =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            isOpen: true,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) => {
              if (surface.id !== surfaceId || surface.kind !== "terminal") return surface;
              const { splitDirection: _splitDirection, ...baseSurface } = surface;
              return {
                ...baseSurface,
                terminalIds: surface.terminalIds.includes(terminalId)
                  ? surface.terminalIds
                  : [...surface.terminalIds, terminalId],
                activeTerminalId: terminalId,
                ...(direction === "vertical" ? { splitDirection: "vertical" as const } : {}),
              };
            }),
          })),
        })),
      activateTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => ({
            ...current,
            activeSurfaceId: surfaceId,
            surfaces: current.surfaces.map((surface) =>
              surface.id === surfaceId &&
              surface.kind === "terminal" &&
              surface.terminalIds.includes(terminalId)
                ? { ...surface, activeTerminalId: terminalId }
                : surface,
            ),
          })),
        })),
      closeTerminal: (ref, surfaceId, terminalId) =>
        set((state) => ({
          byThreadKey: updateThread(state.byThreadKey, scopedThreadKey(ref), (current) => {
            const surface = current.surfaces.find(
              (entry) => entry.id === surfaceId && entry.kind === "terminal",
            );
            if (!surface || surface.kind !== "terminal") return current;
            const terminalIds = surface.terminalIds.filter((id) => id !== terminalId);
            if (terminalIds.length === 0) {
              return removeSurfaceFromThread(current, surfaceId);
            }
            return {
              ...current,
              surfaces: current.surfaces.map((entry) =>
                entry.id === surfaceId && entry.kind === "terminal"
                  ? {
                      ...entry,
                      terminalIds,
                      activeTerminalId:
                        entry.activeTerminalId === terminalId
                          ? (terminalIds.at(-1) ?? terminalIds[0]!)
                          : entry.activeTerminalId,
                    }
                  : entry,
              ),
            };
          }),
        })),
      activateSurface: (ref, surfaceId) => get().activateSurfaceAt(ref, "right", surfaceId),
      activateSurfaceAt: (ref, location, surfaceId) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            current.surfaces.some((surface) => surface.id === surfaceId)
              ? { ...current, isOpen: true, activeSurfaceId: surfaceId }
              : current,
          ),
        ),
      closeSurface: (ref, surfaceId) => get().closeSurfaceAt(ref, "right", surfaceId),
      closeSurfaceAt: (ref, location, surfaceId) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            removeSurfaceFromThread(current, surfaceId),
          ),
        ),
      closeOtherSurfaces: (ref, surfaceId) => get().closeOtherSurfacesAt(ref, "right", surfaceId),
      closeOtherSurfacesAt: (ref, location, surfaceId) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            closeOtherPanelSurfaces(current, surfaceId),
          ),
        ),
      closeSurfacesToRight: (ref, surfaceId) =>
        get().closeSurfacesToRightAt(ref, "right", surfaceId),
      closeSurfacesToRightAt: (ref, location, surfaceId) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            closePanelSurfacesToRight(current, surfaceId),
          ),
        ),
      closeAllSurfaces: (ref) => get().closeAllSurfacesAt(ref, "right"),
      closeAllSurfacesAt: (ref, location) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            current.surfaces.length === 0
              ? current
              : { ...current, isOpen: false, surfaces: [], activeSurfaceId: null },
          ),
        ),
      reconcileBrowserSurfaces: (ref, tabIds) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const validIds = new Set<string>(tabIds.map((tabId) => `browser:${tabId}`));
          const bottomCurrent = state.bottomByThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
          const bottomOwnedIds = new Set<string>(
            bottomCurrent.surfaces
              .filter(
                (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                  surface.kind === "preview" &&
                  surface.id !== "browser:new" &&
                  validIds.has(surface.id),
              )
              .map((surface) => surface.id),
          );
          const rightCurrent = state.byThreadKey[threadKey] ?? EMPTY_THREAD_STATE;
          const rightWithoutBottomDuplicates = [...bottomOwnedIds].reduce(
            (current, surfaceId) => removeSurfaceFromThread(current, surfaceId),
            rightCurrent,
          );
          const rightOwnedIds = new Set<string>(
            rightWithoutBottomDuplicates.surfaces
              .filter(
                (surface): surface is Extract<RightPanelSurface, { kind: "preview" }> =>
                  surface.kind === "preview" &&
                  surface.id !== "browser:new" &&
                  validIds.has(surface.id),
              )
              .map((surface) => surface.id),
          );
          const added = tabIds
            .filter((tabId) => {
              const surfaceId = `browser:${tabId}`;
              return !bottomOwnedIds.has(surfaceId) && !rightOwnedIds.has(surfaceId);
            })
            .map((tabId) => browserSurface(tabId));
          return {
            byThreadKey: updateThread(state.byThreadKey, threadKey, () =>
              reconcilePanelBrowserSurfaces(rightWithoutBottomDuplicates, validIds, added),
            ),
            bottomByThreadKey: updateThread(state.bottomByThreadKey, threadKey, (current) =>
              reconcilePanelBrowserSurfaces(current, validIds),
            ),
          };
        }),
      reconcileFileSurfaces: (ref, workspaceAvailable) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          return {
            byThreadKey: updateThread(state.byThreadKey, threadKey, (current) =>
              reconcilePanelFileSurfaces(current, workspaceAvailable),
            ),
            bottomByThreadKey: updateThread(state.bottomByThreadKey, threadKey, (current) =>
              reconcilePanelFileSurfaces(current, workspaceAvailable),
            ),
          };
        }),
      show: (ref) => get().showAt(ref, "right"),
      showAt: (ref, location) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            current.isOpen ? current : { ...current, isOpen: true },
          ),
        ),
      close: (ref) => get().closeAt(ref, "right"),
      closeAt: (ref, location) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) =>
            current.isOpen ? { ...current, isOpen: false } : current,
          ),
        ),
      toggleVisibility: (ref) => get().toggleVisibilityAt(ref, "right"),
      toggleVisibilityAt: (ref, location) =>
        set((state) =>
          updatePanelAt(state, scopedThreadKey(ref), location, (current) => ({
            ...current,
            isOpen: !current.isOpen,
          })),
        ),
      toggle: (ref, kind) => get().toggleAt(ref, "right", kind),
      toggleAt: (ref, location, kind) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          const current = panelMapForLocation(state, location)[threadKey] ?? EMPTY_THREAD_STATE;
          const active = current.surfaces.find((surface) => surface.id === current.activeSurfaceId);
          if (current.isOpen && active?.kind === kind) {
            return updatePanelAt(state, threadKey, location, (panelState) => ({
              ...panelState,
              isOpen: false,
            }));
          }
          const { surface } = openKindInPanel(current, kind);
          return upsertPanelSurfaceAt(state, threadKey, location, surface);
        }),
      removeThread: (ref) =>
        set((state) => {
          const threadKey = scopedThreadKey(ref);
          if (!(threadKey in state.byThreadKey) && !(threadKey in state.bottomByThreadKey)) {
            return state;
          }
          const { [threadKey]: _removedRight, ...byThreadKey } = state.byThreadKey;
          const { [threadKey]: _removedBottom, ...bottomByThreadKey } = state.bottomByThreadKey;
          return { byThreadKey, bottomByThreadKey };
        }),
    }),
    {
      name: RIGHT_PANEL_STORAGE_KEY,
      version: RIGHT_PANEL_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        byThreadKey: Object.fromEntries(
          Object.entries(state.byThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey),
          ),
        ),
        bottomByThreadKey: Object.fromEntries(
          Object.entries(state.bottomByThreadKey).filter(
            ([threadKey]) => !isPullRequestsPanelKey(threadKey),
          ),
        ),
      }),
      migrate: migratePersistedRightPanelState,
    },
  ),
);

export function selectThreadPanelState(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: "right",
): ThreadRightPanelState;
export function selectThreadPanelState(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: "bottom",
): ThreadBottomPanelState;
export function selectThreadPanelState(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: PanelLocation,
): ThreadPanelState;
export function selectThreadPanelState(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: PanelLocation,
): ThreadPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return panelMapForLocation(state, location)[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectSelectedPanelSurface(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: PanelLocation,
): PanelSurface | null {
  const panel = selectThreadPanelState(state, ref, location);
  return panel.surfaces.find((surface) => surface.id === panel.activeSurfaceId) ?? null;
}

export function selectActivePanelSurface(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  location: PanelLocation,
): PanelSurface | null {
  const panel = selectThreadPanelState(state, ref, location);
  return panel.isOpen ? selectSelectedPanelSurface(state, ref, location) : null;
}

/** Finds the one panel that owns a surface. Bottom wins if corrupted state contains a duplicate. */
export function findPanelSurfaceLocation(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  surfaceId: string,
): PanelLocation | null {
  if (!ref) return null;
  const threadKey = scopedThreadKey(ref);
  if (state.bottomByThreadKey[threadKey]?.surfaces.some((surface) => surface.id === surfaceId)) {
    return "bottom";
  }
  if (state.byThreadKey[threadKey]?.surfaces.some((surface) => surface.id === surfaceId)) {
    return "right";
  }
  return null;
}

export function findBrowserTabPanelLocation(
  state: PanelStateCollections,
  ref: ScopedThreadRef | null | undefined,
  tabId: string,
): PanelLocation | null {
  return findPanelSurfaceLocation(state, ref, `browser:${tabId}`);
}

export function selectThreadBottomPanelState(
  bottomByThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadBottomPanelState {
  if (!ref) return EMPTY_THREAD_STATE as ThreadBottomPanelState;
  return bottomByThreadKey[scopedThreadKey(ref)] ?? (EMPTY_THREAD_STATE as ThreadBottomPanelState);
}

export function selectActiveBottomPanel(
  bottomByThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef | null | undefined,
): BottomPanelSurface["kind"] | null {
  const state = selectThreadBottomPanelState(bottomByThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveBottomPanelSurface(
  bottomByThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef | null | undefined,
): BottomPanelSurface | null {
  const state = selectThreadBottomPanelState(bottomByThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedBottomPanelSurface(bottomByThreadKey, ref);
}

export function selectSelectedBottomPanelSurface(
  bottomByThreadKey: Record<string, ThreadBottomPanelState>,
  ref: ScopedThreadRef | null | undefined,
): BottomPanelSurface | null {
  const state = selectThreadBottomPanelState(bottomByThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

export function selectThreadRightPanelState(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): ThreadRightPanelState {
  if (!ref) return EMPTY_THREAD_STATE;
  return byThreadKey[scopedThreadKey(ref)] ?? EMPTY_THREAD_STATE;
}

export function selectActiveRightPanel(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelKind | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId)?.kind ?? null;
}

export function selectActiveRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  if (!state.isOpen) return null;
  return selectSelectedRightPanelSurface(byThreadKey, ref);
}

/** The selected surface even while the panel is hidden, so a layout control can restore it. */
export function selectSelectedRightPanelSurface(
  byThreadKey: Record<string, ThreadRightPanelState>,
  ref: ScopedThreadRef | null | undefined,
): RightPanelSurface | null {
  const state = selectThreadRightPanelState(byThreadKey, ref);
  return state.surfaces.find((surface) => surface.id === state.activeSurfaceId) ?? null;
}

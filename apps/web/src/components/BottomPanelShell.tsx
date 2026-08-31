import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { cn } from "~/lib/utils";

import { DEFAULT_THREAD_TERMINAL_HEIGHT } from "../types";

export const MIN_BOTTOM_PANEL_HEIGHT = 180;
export const MAX_BOTTOM_PANEL_HEIGHT_RATIO = 0.75;
const BOTTOM_PANEL_KEYBOARD_RESIZE_STEP = 16;

function currentViewportHeight(): number {
  return typeof window === "undefined" ? DEFAULT_THREAD_TERMINAL_HEIGHT : window.innerHeight;
}

export function maxBottomPanelHeight(viewportHeight: number): number {
  const safeViewportHeight = Number.isFinite(viewportHeight)
    ? viewportHeight
    : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.max(
    MIN_BOTTOM_PANEL_HEIGHT,
    Math.floor(safeViewportHeight * MAX_BOTTOM_PANEL_HEIGHT_RATIO),
  );
}

export function clampBottomPanelHeight(height: number, viewportHeight: number): number {
  const safeHeight = Number.isFinite(height) ? height : DEFAULT_THREAD_TERMINAL_HEIGHT;
  return Math.min(
    Math.max(Math.round(safeHeight), MIN_BOTTOM_PANEL_HEIGHT),
    maxBottomPanelHeight(viewportHeight),
  );
}

interface BottomPanelShellProps {
  height: number;
  onHeightChange: (height: number) => void;
  children: ReactNode;
  className?: string;
}

/** Height-resizable shell shared by every bottom-panel surface. */
export function BottomPanelShell({
  height,
  onHeightChange,
  children,
  className,
}: BottomPanelShellProps) {
  const [viewportHeight, setViewportHeight] = useState(currentViewportHeight);
  const [dragHeight, setDragHeight] = useState<number | null>(null);
  const onHeightChangeRef = useRef(onHeightChange);
  const viewportHeightRef = useRef(viewportHeight);
  const resizeStateRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    currentHeight: number;
    didResize: boolean;
  } | null>(null);

  const controlledHeight = clampBottomPanelHeight(height, viewportHeight);
  const panelHeight = clampBottomPanelHeight(dragHeight ?? controlledHeight, viewportHeight);
  const maximumHeight = maxBottomPanelHeight(viewportHeight);

  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  }, [onHeightChange]);

  useEffect(() => {
    viewportHeightRef.current = viewportHeight;
  }, [viewportHeight]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleWindowResize = () => {
      setViewportHeight(window.innerHeight);
    };
    window.addEventListener("resize", handleWindowResize);
    return () => window.removeEventListener("resize", handleWindowResize);
  }, []);

  // Match the terminal drawer's behavior when a window shrink makes its
  // persisted height invalid: clamp once and save the usable value.
  useEffect(() => {
    if (dragHeight !== null || height === controlledHeight) return;
    onHeightChangeRef.current(controlledHeight);
  }, [controlledHeight, dragHeight, height]);

  useEffect(
    () => () => {
      const resizeState = resizeStateRef.current;
      if (!resizeState?.didResize) return;
      onHeightChangeRef.current(
        clampBottomPanelHeight(resizeState.currentHeight, viewportHeightRef.current),
      );
    },
    [],
  );

  const handleResizePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: panelHeight,
        currentHeight: panelHeight,
        didResize: false,
      };
    },
    [panelHeight],
  );

  const handleResizePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      event.preventDefault();
      const nextHeight = clampBottomPanelHeight(
        resizeState.startHeight + (resizeState.startY - event.clientY),
        viewportHeight,
      );
      if (nextHeight === resizeState.currentHeight) return;
      resizeState.currentHeight = nextHeight;
      resizeState.didResize = true;
      setDragHeight(nextHeight);
    },
    [viewportHeight],
  );

  const handleResizePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) return;
      resizeStateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      setDragHeight(null);
      if (resizeState.didResize && resizeState.currentHeight !== controlledHeight) {
        onHeightChangeRef.current(resizeState.currentHeight);
      }
    },
    [controlledHeight],
  );

  const handleResizeKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      const nextHeight =
        event.key === "ArrowUp"
          ? panelHeight + BOTTOM_PANEL_KEYBOARD_RESIZE_STEP
          : event.key === "ArrowDown"
            ? panelHeight - BOTTOM_PANEL_KEYBOARD_RESIZE_STEP
            : event.key === "Home"
              ? MIN_BOTTOM_PANEL_HEIGHT
              : event.key === "End"
                ? maximumHeight
                : null;
      if (nextHeight === null) return;
      event.preventDefault();
      const clampedHeight = clampBottomPanelHeight(nextHeight, viewportHeight);
      if (clampedHeight !== controlledHeight) {
        onHeightChangeRef.current(clampedHeight);
      }
    },
    [controlledHeight, maximumHeight, panelHeight, viewportHeight],
  );

  return (
    <section
      className={cn(
        "relative flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-t border-border/80 bg-background",
        className,
      )}
      style={{ height: `${panelHeight}px` }}
      data-bottom-panel-shell
    >
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize bottom panel"
        aria-orientation="horizontal"
        aria-valuemin={MIN_BOTTOM_PANEL_HEIGHT}
        aria-valuemax={maximumHeight}
        aria-valuenow={panelHeight}
        className="absolute inset-x-0 top-0 z-20 h-1.5 cursor-row-resize outline-none focus-visible:bg-ring/50"
        onPointerDown={handleResizePointerDown}
        onPointerMove={handleResizePointerMove}
        onPointerUp={handleResizePointerEnd}
        onPointerCancel={handleResizePointerEnd}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="flex min-h-0 flex-1 flex-col">{children}</div>
    </section>
  );
}

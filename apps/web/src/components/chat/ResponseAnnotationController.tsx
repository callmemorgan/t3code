import { MessageId, type ResponseAnnotation, type ResponseAnnotationId } from "@t3tools/contracts";
import {
  RESPONSE_ANNOTATION_MAX_COMMENT_CHARS,
  RESPONSE_ANNOTATION_MAX_COUNT,
  RESPONSE_ANNOTATION_MAX_SELECTED_TEXT_CHARS,
} from "@t3tools/contracts";
import {
  createContext,
  cloneElement,
  isValidElement,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import type { ReactNode, PointerEvent as ReactPointerEvent } from "react";
import { MessageSquarePlusIcon, Trash2Icon } from "lucide-react";

import {
  buildRenderedTextIndex,
  domRangeForResponseAnnotation,
  newResponseAnnotationId,
  responseAnnotationSourceRangeFromDomRange,
} from "../../lib/responseAnnotations";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const EMPTY_RESPONSE_ANNOTATIONS: ReadonlyArray<ResponseAnnotation> = [];
const EMPTY_RESPONSE_ANNOTATION_MARKERS: ReadonlyArray<ResponseAnnotationSourceMarker> = [];

export interface ResponseAnnotationSelection {
  readonly sourceMessageId: MessageId;
  readonly selectedText: string;
  readonly sourceRange: ResponseAnnotation["sourceRange"];
  readonly rect: ResponseAnnotationFloatingRect;
  readonly range: Range;
}

export interface ResponseAnnotationFloatingRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export interface ResponseAnnotationNavigationRequest {
  readonly annotation: ResponseAnnotation;
  /** Change this value when requesting a second jump to the same annotation. */
  readonly requestId?: string | number;
  /** The one-based number in the originating user message, when known. */
  readonly number?: number;
}

/** A source marker keeps its originating message's number and editability. */
export interface ResponseAnnotationSourceMarker {
  readonly annotation: ResponseAnnotation;
  readonly number: number;
  readonly editable: boolean;
}

export interface ResponseAnnotationTimelineControllerProps {
  readonly supported?: boolean;
  readonly draftAnnotations?: ReadonlyArray<ResponseAnnotation>;
  /** Annotations already attached to loaded user messages; these are read-only. */
  readonly sentAnnotations?: ReadonlyArray<ResponseAnnotationSourceMarker>;
  readonly onCreateResponseAnnotation?:
    | ((annotation: ResponseAnnotation) => boolean | void)
    | undefined;
  readonly onUpdateResponseAnnotation?:
    | ((annotationId: ResponseAnnotationId, comment: string) => void)
    | undefined;
  readonly onDeleteResponseAnnotation?: ((annotationId: ResponseAnnotationId) => void) | undefined;
  readonly navigationRequest?: ResponseAnnotationNavigationRequest | null | undefined;
  /** Rendered-row identity used to retry a pending jump after virtualization changes. */
  readonly navigationRetrySignal?: unknown;
  /** Scroll the virtualized list so the source message can be mounted. */
  readonly onRequestResponseAnnotationSource?: ((messageId: MessageId) => void) | undefined;
  readonly children: ReactNode;
}

/** Array order is the provider-facing one-based annotation number. */
export function deriveResponseAnnotationNumbers(
  annotations: ReadonlyArray<ResponseAnnotation>,
): ReadonlyMap<ResponseAnnotationId, number> {
  return new Map(annotations.map((annotation, index) => [annotation.id, index + 1]));
}

export function canCreateResponseAnnotation(annotationCount: number): boolean {
  return (
    Number.isSafeInteger(annotationCount) &&
    annotationCount >= 0 &&
    annotationCount < RESPONSE_ANNOTATION_MAX_COUNT
  );
}

interface ResponseAnnotationTimelineContextValue {
  readonly sourceMarkersByMessageId: ReadonlyMap<
    MessageId,
    ReadonlyArray<ResponseAnnotationSourceMarker>
  >;
  readonly onMarkerSelect: (marker: ResponseAnnotationSourceMarker, rect: DOMRect) => void;
  readonly onMarkerLayout: (annotationId: ResponseAnnotationId) => void;
  readonly onResponseAnnotationClick: (annotation: ResponseAnnotation, index: number) => void;
}

const responseAnnotationTimelineContext = createContext<ResponseAnnotationTimelineContextValue>({
  sourceMarkersByMessageId: new Map(),
  onMarkerSelect: () => {},
  onMarkerLayout: () => {},
  onResponseAnnotationClick: () => {},
});

export function useResponseAnnotationTimelineContext(): ResponseAnnotationTimelineContextValue {
  return use(responseAnnotationTimelineContext);
}

function sourceElementForNode(node: Node | null): HTMLElement | null {
  if (!node) return null;
  const element = node.nodeType === 1 ? (node as Element) : node.parentElement;
  return element?.closest<HTMLElement>("[data-response-annotation-source='true']") ?? null;
}

function sourceMarkdownRoot(sourceElement: HTMLElement): HTMLElement | null {
  return sourceElement.querySelector<HTMLElement>(".chat-markdown");
}

function isNodeInElement(node: Node | null, element: Node): boolean {
  return node !== null && (node === element || element.contains(node));
}

/**
 * Return true only for a non-empty selection whose two endpoints belong to
 * one completed assistant source. Controls and source markers live outside
 * `.chat-markdown`, so selecting them cannot create an annotation.
 */
export function isResponseAnnotationSelectionContained(
  selection: Selection | null,
  timelineRoot: HTMLElement | null,
): { readonly sourceElement: HTMLElement; readonly range: Range } | null {
  if (
    !selection ||
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    !timelineRoot ||
    typeof selection.getRangeAt !== "function"
  ) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const sourceFromAnchor = sourceElementForNode(selection.anchorNode);
  const sourceFromFocus = sourceElementForNode(selection.focusNode);
  if (!sourceFromAnchor || sourceFromAnchor !== sourceFromFocus) return null;
  if (
    sourceFromAnchor.dataset.responseAnnotationStreaming === "true" ||
    sourceFromAnchor.dataset.responseAnnotationSelectable === "false"
  ) {
    return null;
  }

  const markdownRoot = sourceMarkdownRoot(sourceFromAnchor);
  if (!markdownRoot) return null;
  if (
    !timelineRoot.contains(sourceFromAnchor) ||
    !isNodeInElement(range.commonAncestorContainer, markdownRoot) ||
    !isNodeInElement(selection.anchorNode, markdownRoot) ||
    !isNodeInElement(selection.focusNode, markdownRoot)
  ) {
    return null;
  }

  return { sourceElement: sourceFromAnchor, range };
}

/** Convert a contained DOM selection into the persisted response annotation fields. */
export function responseAnnotationSelectionFromDom(
  selection: Selection | null,
  timelineRoot: HTMLElement | null,
): Omit<ResponseAnnotation, "id" | "comment"> | null {
  const contained = isResponseAnnotationSelectionContained(selection, timelineRoot);
  if (!contained) return null;
  const markdownRoot = sourceMarkdownRoot(contained.sourceElement);
  if (!markdownRoot) return null;

  const index = buildRenderedTextIndex(markdownRoot);
  const sourceRange = responseAnnotationSourceRangeFromDomRange(contained.range, index);
  if (!sourceRange) return null;
  const selectedText = index.text.slice(sourceRange.start, sourceRange.end);
  if (
    selectedText.trim().length === 0 ||
    selectedText.length > RESPONSE_ANNOTATION_MAX_SELECTED_TEXT_CHARS
  ) {
    return null;
  }

  const sourceMessageId = contained.sourceElement.dataset.responseAnnotationMessageId;
  if (!sourceMessageId) return null;

  return {
    sourceMessageId: MessageId.make(sourceMessageId),
    selectedText,
    sourceRange,
  };
}

export function responseAnnotationRectFromDomRect(
  rect: DOMRect | DOMRectReadOnly,
): ResponseAnnotationFloatingRect {
  return {
    top: rect.top,
    left: rect.left,
    width: rect.width,
    height: rect.height,
  };
}

export function responseAnnotationActionPosition(
  rect: ResponseAnnotationFloatingRect,
  viewport: { readonly width: number; readonly height: number },
): { readonly left: number; readonly top: number; readonly transform: string } {
  const viewportGap = 12;
  const popoverGap = 8;
  const estimatedHeight = 36;
  const halfWidth = 58;
  const minCenter = viewportGap + halfWidth;
  const maxCenter = viewport.width - viewportGap - halfWidth;
  const left =
    maxCenter < minCenter
      ? viewport.width / 2
      : Math.max(minCenter, Math.min(maxCenter, rect.left + rect.width / 2));
  const bottom = rect.top + rect.height;
  const above =
    rect.top > 96 || bottom + popoverGap + estimatedHeight > viewport.height - viewportGap;
  if (above) {
    return {
      left,
      top: Math.max(
        estimatedHeight + viewportGap,
        Math.min(viewport.height - viewportGap, rect.top - popoverGap),
      ),
      transform: "translate(-50%, -100%)",
    };
  }
  return {
    left,
    top: Math.max(
      viewportGap,
      Math.min(bottom + popoverGap, viewport.height - viewportGap - estimatedHeight),
    ),
    transform: "translateX(-50%)",
  };
}

export function responseAnnotationEditorPosition(
  anchorRect: ResponseAnnotationFloatingRect,
  viewport: { readonly width: number; readonly height: number },
): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly maxHeight: number;
} {
  const edgeGap = 16;
  const width = Math.min(360, Math.max(220, viewport.width - edgeGap * 2));
  const resolvedWidth = Math.min(width, Math.max(1, viewport.width - edgeGap * 2));
  const right = anchorRect.left + anchorRect.width + 12;
  const left =
    right + resolvedWidth <= viewport.width - edgeGap
      ? right
      : Math.max(edgeGap, anchorRect.left - resolvedWidth - 12);
  const maxHeight = Math.max(1, viewport.height - edgeGap * 2);
  const height = Math.min(220, maxHeight);
  const minTop = Math.min(edgeGap, Math.max(0, viewport.height - height));
  const maxTop = Math.max(minTop, viewport.height - edgeGap - height);
  return {
    left: Math.max(edgeGap, Math.min(viewport.width - edgeGap - resolvedWidth, left)),
    top: Math.max(minTop, Math.min(maxTop, anchorRect.top - 24)),
    width: resolvedWidth,
    height,
    maxHeight,
  };
}

export function responseAnnotationEditorPresentation(number: number, editable: boolean) {
  return {
    ariaLabel: `${editable ? "Edit" : "View"} Annotation ${number}`,
    closeLabel: editable ? "Cancel" : "Close",
    readOnly: !editable,
  } as const;
}

function rangeClientRects(range: Range): ResponseAnnotationFloatingRect[] {
  const rects = Array.from(range.getClientRects?.() ?? []);
  const usableRects = rects.filter((rect) => rect.width > 0 || rect.height > 0);
  if (usableRects.length > 0) return usableRects.map(responseAnnotationRectFromDomRect);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 || rect.height > 0 ? [responseAnnotationRectFromDomRect(rect)] : [];
}

function findSourceElement(
  annotation: ResponseAnnotation,
  timelineRoot?: HTMLElement | null,
): HTMLElement | null {
  if (typeof document === "undefined") return null;
  const candidates = (timelineRoot ?? document).querySelectorAll<HTMLElement>(
    "[data-response-annotation-source='true']",
  );
  for (const candidate of candidates) {
    if (candidate.dataset.responseAnnotationMessageId === annotation.sourceMessageId) {
      return candidate;
    }
  }
  return null;
}

function responseAnnotationNavigationKey(
  request: ResponseAnnotationNavigationRequest,
): string | number {
  return request.requestId ?? request.annotation.id;
}

interface ResponseAnnotationMarkerPlacement {
  readonly annotation: ResponseAnnotation;
  readonly left: number;
  readonly top: number;
}

export function responseAnnotationMarkerPosition(
  selectionRect: ResponseAnnotationFloatingRect,
  sourceRect: ResponseAnnotationFloatingRect,
): { readonly left: number; readonly top: number } {
  const markerSize = 20;
  const markerGap = 4;
  const endpoint = selectionRect.left - sourceRect.left + selectionRect.width;
  // Source rows are clipped horizontally by the virtualized list. Keep the
  // bubble inside the source root when the selected line reaches its edge;
  // otherwise the marker exists in the DOM but is invisible to the user.
  const maxLeft = sourceRect.width > 0 ? Math.max(0, sourceRect.width - markerSize) : endpoint;
  const maxTop = sourceRect.height > 0 ? Math.max(0, sourceRect.height - markerSize) : 0;
  const aboveSelection = selectionRect.top - sourceRect.top - markerSize - markerGap;
  return {
    left: Math.max(0, Math.min(maxLeft, endpoint + markerGap)),
    top: Math.max(0, Math.min(maxTop, aboveSelection)),
  };
}

export function ResponseAnnotationSourceMarkers({
  markers,
  sourceMessageId,
}: {
  readonly markers: ReadonlyArray<ResponseAnnotationSourceMarker>;
  readonly sourceMessageId: MessageId;
}) {
  const { onMarkerLayout, onMarkerSelect, onResponseAnnotationClick } =
    useResponseAnnotationTimelineContext();
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const [placements, setPlacements] = useState<ReadonlyArray<ResponseAnnotationMarkerPlacement>>(
    [],
  );

  const measure = useCallback(() => {
    const source = sourceRef.current?.parentElement;
    const markdownRoot = source?.querySelector<HTMLElement>(".chat-markdown");
    if (!source || !markdownRoot) {
      setPlacements([]);
      return;
    }
    const sourceRect = source.getBoundingClientRect();
    const next = markers.flatMap(({ annotation }) => {
      const range = domRangeForResponseAnnotation(
        markdownRoot,
        annotation.selectedText,
        annotation.sourceRange,
      );
      if (!range) return [];
      const rects = rangeClientRects(range);
      const rect = rects.at(-1);
      if (!rect) return [];
      return [
        {
          annotation,
          ...responseAnnotationMarkerPosition(rect, responseAnnotationRectFromDomRect(sourceRect)),
        },
      ];
    });
    setPlacements(next);
  }, [markers]);

  useLayoutEffect(() => {
    const frame = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(frame);
  }, [measure]);

  useEffect(() => {
    const source = sourceRef.current;
    if (!source || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(source);
    return () => observer.disconnect();
  }, [measure]);

  // The marker gutter reflows the markdown before the measured placements
  // settle. Refresh an open editor once the positioned marker has committed;
  // the controller ignores unchanged rects, so this cannot create a loop.
  useLayoutEffect(() => {
    if (placements.length === 0) return;
    const frame = requestAnimationFrame(() => {
      for (const marker of markers) onMarkerLayout(marker.annotation.id);
    });
    return () => cancelAnimationFrame(frame);
  }, [markers, onMarkerLayout, placements]);

  return (
    <div
      ref={sourceRef}
      className="pointer-events-none absolute inset-0 z-20 overflow-visible"
      data-response-annotation-markers={sourceMessageId}
      role={markers.length > 0 ? "group" : undefined}
      aria-label={markers.length > 0 ? "Response annotations" : undefined}
    >
      {markers.map((marker, index) => {
        const { annotation, number, editable } = marker;
        const placement = placements.find((candidate) => candidate.annotation.id === annotation.id);
        const description = annotation.comment.trim()
          ? `${annotation.selectedText}. ${annotation.comment.trim()}`
          : annotation.selectedText;
        return (
          <Tooltip key={annotation.id}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "pointer-events-auto absolute inline-flex size-5 cursor-pointer items-center justify-center rounded-full border border-background bg-blue-500 text-[10px] font-semibold leading-none text-white shadow-sm after:absolute after:-bottom-0.5 after:left-0.5 after:size-2 after:rotate-45 after:rounded-[2px] after:bg-blue-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  )}
                  style={
                    placement
                      ? { left: placement.left, top: placement.top }
                      : { right: 0, top: 20 + index * 24 }
                  }
                  data-response-annotation-marker={annotation.id}
                  data-response-annotation-marker-editable={editable ? "true" : "false"}
                  aria-label={
                    editable ? `Edit Annotation ${number}` : `Annotation ${number}: ${description}`
                  }
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    if (!editable) onResponseAnnotationClick(annotation, number);
                    onMarkerSelect(marker, event.currentTarget.getBoundingClientRect());
                  }}
                >
                  <span className="relative z-10">{number}</span>
                </button>
              }
            />
            <TooltipPopup
              side="top"
              className="max-w-[min(32rem,calc(100vw-2rem))] whitespace-pre-wrap wrap-anywhere"
            >
              {editable ? `Annotation ${number}` : `Annotation ${number}: ${description}`}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** A small, portal-positioned action that leaves native text selection intact. */
function ResponseAnnotationSelectionAction({
  rect,
  disabled,
  onAnnotate,
}: {
  readonly rect: ResponseAnnotationFloatingRect;
  readonly disabled: boolean;
  readonly onAnnotate: () => void;
}) {
  const position = responseAnnotationActionPosition(rect, {
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  });
  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      data-response-annotation-ui="true"
      role="toolbar"
      aria-label="Selected text actions"
      style={position}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <Button
        type="button"
        size="sm"
        disabled={disabled}
        aria-label={disabled ? "Annotation limit reached" : "Annotate selected text"}
        className="rounded-xl border border-border/80 bg-popover text-popover-foreground shadow-lg hover:bg-accent"
        onPointerDown={(event) => event.preventDefault()}
        onClick={onAnnotate}
      >
        <MessageSquarePlusIcon className="size-3.5" aria-hidden />
        Annotate
      </Button>
    </div>,
    document.body,
  );
}

function ResponseAnnotationEditor({
  annotation,
  number,
  editable,
  anchorRect,
  onCancel,
  onDelete,
  onSave,
}: {
  readonly annotation: ResponseAnnotation;
  readonly number: number;
  readonly editable: boolean;
  readonly anchorRect: ResponseAnnotationFloatingRect;
  readonly onCancel: () => void;
  readonly onDelete?: (() => void) | undefined;
  readonly onSave?: ((comment: string) => void) | undefined;
}) {
  const [comment, setComment] = useState(annotation.comment);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const presentation = responseAnnotationEditorPresentation(number, editable);
  const position = responseAnnotationEditorPosition(anchorRect, {
    width: typeof window === "undefined" ? 1024 : window.innerWidth,
    height: typeof window === "undefined" ? 768 : window.innerHeight,
  });

  useEffect(() => {
    setComment(annotation.comment);
    const frame = requestAnimationFrame(() => textareaRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [annotation.comment, annotation.id]);

  return createPortal(
    <form
      className="fixed z-[72] flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/80 bg-popover p-3 text-popover-foreground shadow-xl"
      style={position}
      data-response-annotation-ui="true"
      aria-label={presentation.ariaLabel}
      onPointerDown={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      onSubmit={(event) => {
        event.preventDefault();
        if (editable && onSave && comment !== annotation.comment) onSave(comment);
      }}
    >
      <textarea
        ref={textareaRef}
        value={comment}
        maxLength={RESPONSE_ANNOTATION_MAX_COMMENT_CHARS}
        aria-label="Annotation comment"
        readOnly={presentation.readOnly}
        placeholder={editable ? "Add an optional comment..." : "No comment"}
        className="min-h-0 w-full flex-1 resize-none overflow-y-auto rounded-lg border border-border/70 bg-background/70 p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setComment(event.target.value)}
      />
      <div className="mt-2 flex shrink-0 items-center justify-between gap-2">
        {editable && onDelete ? (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            aria-label="Delete annotation"
            onClick={onDelete}
          >
            <Trash2Icon aria-hidden />
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onCancel}>
            {presentation.closeLabel}
          </Button>
          {editable ? (
            <Button type="submit" size="sm" disabled={comment === annotation.comment}>
              Save
            </Button>
          ) : null}
        </div>
      </div>
    </form>,
    document.body,
  );
}

function historicalMarkerPosition(rect: ResponseAnnotationFloatingRect) {
  return {
    left: Math.min(
      Math.max(8, rect.left + rect.width + 6),
      (typeof window === "undefined" ? 1024 : window.innerWidth) - 28,
    ),
    top: rect.top + rect.height / 2,
  };
}

function HistoricalResponseAnnotationJump({
  annotation,
  number,
  rects,
  showMarker,
}: {
  readonly annotation: ResponseAnnotation;
  readonly number: number;
  readonly rects: ReadonlyArray<ResponseAnnotationFloatingRect>;
  readonly showMarker: boolean;
}) {
  if (rects.length === 0) return null;
  const marker = historicalMarkerPosition(rects[0]!);
  return createPortal(
    <>
      {rects.map((rect) => (
        <span
          key={`${annotation.id}-highlight-${rect.top}-${rect.left}-${rect.width}-${rect.height}`}
          className="pointer-events-none fixed z-[68] rounded-sm bg-blue-400/25 ring-1 ring-blue-400/35"
          data-response-annotation-highlight={annotation.id}
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
      ))}
      {showMarker ? (
        <span
          className="pointer-events-none fixed z-[69] inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-full border border-background bg-blue-500 text-[10px] font-semibold text-white shadow-sm"
          data-response-annotation-historical-marker={annotation.id}
          aria-label={`Annotation ${number}`}
          style={marker}
        >
          {number}
        </span>
      ) : null}
    </>,
    document.body,
  );
}

export function ResponseAnnotationTimelineController({
  supported = false,
  draftAnnotations = EMPTY_RESPONSE_ANNOTATIONS,
  sentAnnotations = EMPTY_RESPONSE_ANNOTATION_MARKERS,
  onCreateResponseAnnotation,
  onUpdateResponseAnnotation,
  onDeleteResponseAnnotation,
  navigationRequest = null,
  navigationRetrySignal,
  onRequestResponseAnnotationSource,
  children,
}: ResponseAnnotationTimelineControllerProps) {
  const timelineRootRef = useRef<HTMLDivElement | null>(null);
  const selectionRef = useRef<ResponseAnnotationSelection | null>(null);
  const editorRef = useRef<{
    readonly annotation: ResponseAnnotation;
    readonly number: number;
    readonly editable: boolean;
    readonly anchorRect: ResponseAnnotationFloatingRect;
  } | null>(null);
  const pointerControllerRef = useRef<AbortController | null>(null);
  const selectionReadFrameRef = useRef<number | null>(null);
  const viewportFrameRef = useRef<number | null>(null);
  const navigationFrameRef = useRef<number | null>(null);
  const navigationObserverRef = useRef<MutationObserver | null>(null);
  const navigationKeyRef = useRef<string | number | null>(null);
  const pendingNavigationKeyRef = useRef<string | number | null>(null);
  const activeNavigationRequestRef = useRef<ResponseAnnotationNavigationRequest | null>(null);
  const activeNavigationSourceRef = useRef<"prop" | "direct" | null>(null);
  const directNavigationSequenceRef = useRef(0);
  const historicalTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [selection, setSelection] = useState<ResponseAnnotationSelection | null>(null);
  const [editor, setEditor] = useState<{
    readonly annotation: ResponseAnnotation;
    readonly number: number;
    readonly editable: boolean;
    readonly anchorRect: ResponseAnnotationFloatingRect;
  } | null>(null);
  const [optimisticAnnotations, setOptimisticAnnotations] = useState<
    ReadonlyArray<ResponseAnnotation>
  >([]);
  const [deletedAnnotationIds, setDeletedAnnotationIds] = useState<
    ReadonlySet<ResponseAnnotationId>
  >(new Set());
  const [historicalJump, setHistoricalJump] = useState<{
    readonly annotation: ResponseAnnotation;
    readonly number: number;
    readonly rects: ReadonlyArray<ResponseAnnotationFloatingRect>;
    readonly showMarker: boolean;
  } | null>(null);
  const previousDraftAnnotationsRef = useRef<ReadonlyArray<ResponseAnnotation>>(draftAnnotations);
  const floatingUiOpen = selection !== null || editor !== null;

  const stopNavigationObservation = useCallback(() => {
    navigationObserverRef.current?.disconnect();
    navigationObserverRef.current = null;
  }, []);

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    if (optimisticAnnotations.length === 0 || draftAnnotations.length === 0) return;
    const acknowledgedIds = new Set(draftAnnotations.map((annotation) => annotation.id));
    setOptimisticAnnotations((existing) =>
      existing.filter((annotation) => !acknowledgedIds.has(annotation.id)),
    );
  }, [draftAnnotations, optimisticAnnotations.length]);

  // A successful send clears the draft before the server echoes the user
  // message back through the timeline. Optimistic markers are only draft UI;
  // retaining them here would leave an editable editor attached to a sent
  // annotation until the route remounts.
  useEffect(() => {
    const previousDraftAnnotations = previousDraftAnnotationsRef.current;
    previousDraftAnnotationsRef.current = draftAnnotations;
    if (
      optimisticAnnotations.length === 0 ||
      draftAnnotations.length > 0 ||
      previousDraftAnnotations.length === 0
    ) {
      return;
    }
    setOptimisticAnnotations([]);
  }, [draftAnnotations, optimisticAnnotations.length]);

  const effectiveAnnotations = useMemo(() => {
    if (optimisticAnnotations.length === 0 && deletedAnnotationIds.size === 0) {
      return draftAnnotations;
    }
    const byId = new Map(
      draftAnnotations
        .filter((annotation) => !deletedAnnotationIds.has(annotation.id))
        .map((annotation) => [annotation.id, annotation]),
    );
    for (const annotation of optimisticAnnotations) {
      if (!deletedAnnotationIds.has(annotation.id)) byId.set(annotation.id, annotation);
    }
    return Array.from(byId.values());
  }, [deletedAnnotationIds, draftAnnotations, optimisticAnnotations]);
  const numberByAnnotationId = useMemo(
    () => deriveResponseAnnotationNumbers(effectiveAnnotations),
    [effectiveAnnotations],
  );
  const sourceMarkersByMessageId = useMemo(() => {
    const byMessageId = new Map<MessageId, ResponseAnnotationSourceMarker[]>();
    const draftIds = new Set<ResponseAnnotationId>();

    for (const annotation of effectiveAnnotations) {
      const number = numberByAnnotationId.get(annotation.id);
      if (number === undefined) continue;
      draftIds.add(annotation.id);
      const existing = byMessageId.get(annotation.sourceMessageId) ?? [];
      existing.push({ annotation, number, editable: true });
      byMessageId.set(annotation.sourceMessageId, existing);
    }

    // A just-sent annotation can briefly be present in both the composer
    // draft and the loaded user message. Keep the draft marker in that race;
    // it remains editable until the draft is acknowledged and then the
    // read-only marker takes over without duplicating the bubble.
    for (const marker of sentAnnotations) {
      if (draftIds.has(marker.annotation.id)) continue;
      const existing = byMessageId.get(marker.annotation.sourceMessageId) ?? [];
      existing.push(marker);
      byMessageId.set(marker.annotation.sourceMessageId, existing);
    }

    return byMessageId;
  }, [effectiveAnnotations, numberByAnnotationId, sentAnnotations]);

  const readTextSelection = useCallback(() => {
    if (!supported || editor !== null) return;
    const nativeSelection = typeof window === "undefined" ? null : window.getSelection();
    const contained = isResponseAnnotationSelectionContained(
      nativeSelection,
      timelineRootRef.current,
    );
    const nextFields = responseAnnotationSelectionFromDom(nativeSelection, timelineRootRef.current);
    if (!contained || !nextFields) {
      selectionRef.current = null;
      setSelection(null);
      return;
    }
    const rect = contained.range.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      selectionRef.current = null;
      setSelection(null);
      return;
    }
    const nextSelection: ResponseAnnotationSelection = {
      ...nextFields,
      rect: responseAnnotationRectFromDomRect(rect),
      range: contained.range,
    };
    selectionRef.current = nextSelection;
    setSelection(nextSelection);
  }, [editor, supported]);

  const scheduleReadTextSelection = useCallback(() => {
    if (selectionReadFrameRef.current !== null) cancelAnimationFrame(selectionReadFrameRef.current);
    selectionReadFrameRef.current = requestAnimationFrame(() => {
      selectionReadFrameRef.current = null;
      readTextSelection();
    });
  }, [readTextSelection]);

  const refreshFloatingRects = useCallback(() => {
    if (selectionRef.current) {
      const rect = selectionRef.current.range.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        const next = { ...selectionRef.current, rect: responseAnnotationRectFromDomRect(rect) };
        selectionRef.current = next;
        setSelection(next);
      }
    }

    const currentEditor = editorRef.current;
    if (currentEditor) {
      const marker = document.querySelector<HTMLElement>(
        `[data-response-annotation-marker="${currentEditor.annotation.id}"]`,
      );
      const markerRect = marker?.getBoundingClientRect();
      if (markerRect && (markerRect.width > 0 || markerRect.height > 0)) {
        setEditor((existing) =>
          existing
            ? { ...existing, anchorRect: responseAnnotationRectFromDomRect(markerRect) }
            : existing,
        );
      }
    }
  }, []);

  const scheduleRefreshFloatingRects = useCallback(() => {
    if (viewportFrameRef.current !== null) return;
    viewportFrameRef.current = requestAnimationFrame(() => {
      viewportFrameRef.current = null;
      refreshFloatingRects();
    });
  }, [refreshFloatingRects]);

  useEffect(() => {
    if (!supported) return;
    const onSelectionChange = () => scheduleReadTextSelection();
    document.addEventListener("selectionchange", onSelectionChange);
    return () => document.removeEventListener("selectionchange", onSelectionChange);
  }, [scheduleReadTextSelection, supported]);

  useEffect(() => {
    if (!floatingUiOpen) return;
    const onViewportChange = () => scheduleRefreshFloatingRects();
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("scroll", onViewportChange, true);
    return () => {
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
    };
  }, [floatingUiOpen, scheduleRefreshFloatingRects]);

  useEffect(
    () => () => {
      pointerControllerRef.current?.abort();
      if (selectionReadFrameRef.current !== null)
        cancelAnimationFrame(selectionReadFrameRef.current);
      if (viewportFrameRef.current !== null) cancelAnimationFrame(viewportFrameRef.current);
      if (navigationFrameRef.current !== null) cancelAnimationFrame(navigationFrameRef.current);
      stopNavigationObservation();
      if (historicalTimeoutRef.current !== null) clearTimeout(historicalTimeoutRef.current);
    },
    [stopNavigationObservation],
  );

  const handlePointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!supported || editor !== null) return;
      pointerControllerRef.current?.abort();
      const controller = new AbortController();
      pointerControllerRef.current = controller;
      const pointerId = event.pointerId;
      const options = { signal: controller.signal };
      const handlePointerUp = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== pointerId) return;
        controller.abort();
        scheduleReadTextSelection();
      };
      const handlePointerCancel = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId === pointerId) controller.abort();
      };
      window.addEventListener("pointerup", handlePointerUp, options);
      window.addEventListener("pointercancel", handlePointerCancel, options);
    },
    [editor, scheduleReadTextSelection, supported],
  );

  useEffect(() => {
    if (!selection && !editor) return;
    const onOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-response-annotation-ui='true']")) {
        return;
      }
      if (editor) {
        setEditor(null);
        return;
      }
      setSelection(null);
      selectionRef.current = null;
    };
    document.addEventListener("pointerdown", onOutsidePointerDown, true);
    return () => document.removeEventListener("pointerdown", onOutsidePointerDown, true);
  }, [editor, selection]);

  const restoreMarkerFocus = useCallback((annotationId: ResponseAnnotationId) => {
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-response-annotation-marker="${annotationId}"]`)
        ?.focus();
    });
  }, []);

  const restoreSourceFocus = useCallback((annotation: ResponseAnnotation) => {
    requestAnimationFrame(() => {
      findSourceElement(annotation, timelineRootRef.current)?.focus({ preventScroll: true });
    });
  }, []);

  const createFromSelection = useCallback(() => {
    const current = selectionRef.current;
    if (!current || !canCreateResponseAnnotation(effectiveAnnotations.length)) return;
    const annotation: ResponseAnnotation = {
      id: newResponseAnnotationId(),
      sourceMessageId: current.sourceMessageId,
      selectedText: current.selectedText,
      sourceRange: current.sourceRange,
      comment: "",
    };
    const accepted = onCreateResponseAnnotation?.(annotation);
    if (accepted === false) return;
    setOptimisticAnnotations((existing) => [...existing, annotation]);
    selectionRef.current = null;
    setSelection(null);
    setEditor({
      annotation,
      number: effectiveAnnotations.length + 1,
      editable: true,
      anchorRect: current.rect,
    });
  }, [effectiveAnnotations.length, onCreateResponseAnnotation]);

  const closeEditor = useCallback(
    (annotationId?: ResponseAnnotationId) => {
      setEditor(null);
      if (annotationId) restoreMarkerFocus(annotationId);
    },
    [restoreMarkerFocus],
  );

  const handleMarkerSelect = useCallback(
    (marker: ResponseAnnotationSourceMarker, rect: DOMRect) => {
      setSelection(null);
      selectionRef.current = null;
      setEditor({ ...marker, anchorRect: responseAnnotationRectFromDomRect(rect) });
    },
    [],
  );

  const resolveNavigation = useCallback(
    (request: ResponseAnnotationNavigationRequest, attemptsRemaining: number) => {
      const key = responseAnnotationNavigationKey(request);
      const activeRequest = activeNavigationRequestRef.current;
      if (activeRequest !== null && responseAnnotationNavigationKey(activeRequest) !== key) {
        return;
      }
      const source = findSourceElement(request.annotation, timelineRootRef.current);
      if (!source) {
        pendingNavigationKeyRef.current = key;

        // A virtualized row may take longer than a few frames to mount, and a
        // paginated source may not arrive until an async request completes.
        // Keep a narrowly scoped observer alive while this one jump is
        // pending so the next source-root insertion gets another resolution
        // attempt without polling the whole timeline.
        if (
          navigationObserverRef.current === null &&
          timelineRootRef.current &&
          typeof MutationObserver !== "undefined"
        ) {
          const observer = new MutationObserver((records) => {
            const active = activeNavigationRequestRef.current;
            if (
              active === null ||
              responseAnnotationNavigationKey(active) !== pendingNavigationKeyRef.current
            ) {
              stopNavigationObservation();
              return;
            }
            const sourceRootAdded = records.some((record) =>
              Array.from(record.addedNodes).some((node) => {
                if (node.nodeType !== Node.ELEMENT_NODE) return false;
                const element = node as Element;
                return (
                  element.matches("[data-response-annotation-source='true']") ||
                  element.querySelector("[data-response-annotation-source='true']") !== null
                );
              }),
            );
            if (!sourceRootAdded || navigationFrameRef.current !== null) return;
            navigationFrameRef.current = requestAnimationFrame(() => {
              navigationFrameRef.current = null;
              resolveNavigation(active, 3);
            });
          });
          observer.observe(timelineRootRef.current, { childList: true, subtree: true });
          navigationObserverRef.current = observer;
        }
        onRequestResponseAnnotationSource?.(request.annotation.sourceMessageId);
        if (attemptsRemaining > 0) {
          navigationFrameRef.current = requestAnimationFrame(() =>
            resolveNavigation(request, attemptsRemaining - 1),
          );
        }
        return;
      }
      const markdownRoot = sourceMarkdownRoot(source);
      const range = markdownRoot
        ? domRangeForResponseAnnotation(
            markdownRoot,
            request.annotation.selectedText,
            request.annotation.sourceRange,
          )
        : null;
      if (!range) {
        // Keep the request keyed as completed so a prop that remains set does
        // not restart the same navigation on every render. A missing range is
        // terminal for this source, while a missing source below remains
        // pending because virtualization or pagination may mount it later.
        navigationKeyRef.current = key;
        pendingNavigationKeyRef.current = null;
        stopNavigationObservation();
        source.scrollIntoView?.({ block: "center", behavior: "auto" });
        return;
      }
      source.scrollIntoView?.({ block: "center", behavior: "auto" });
      const rects = rangeClientRects(range);
      if (rects.length === 0) {
        pendingNavigationKeyRef.current = request.requestId ?? request.annotation.id;
        if (attemptsRemaining > 0) {
          navigationFrameRef.current = requestAnimationFrame(() =>
            resolveNavigation(request, attemptsRemaining - 1),
          );
        }
        return;
      }
      // Retain the request and key after success. The root keeps a prop
      // request until the route changes, so clearing it here would make the
      // effect replay the same navigation on every render.
      navigationKeyRef.current = key;
      pendingNavigationKeyRef.current = null;
      stopNavigationObservation();
      setHistoricalJump({
        annotation: request.annotation,
        number: request.number ?? numberByAnnotationId.get(request.annotation.id) ?? 1,
        rects,
        showMarker:
          timelineRootRef.current?.querySelector<HTMLElement>(
            `[data-response-annotation-marker="${request.annotation.id}"]`,
          ) === null,
      });
      if (historicalTimeoutRef.current !== null) clearTimeout(historicalTimeoutRef.current);
      historicalTimeoutRef.current = setTimeout(() => setHistoricalJump(null), 1800);
    },
    [numberByAnnotationId, onRequestResponseAnnotationSource, stopNavigationObservation],
  );

  const handleResponseAnnotationClick = useCallback(
    (annotation: ResponseAnnotation, index: number) => {
      const request: ResponseAnnotationNavigationRequest = {
        annotation,
        number: index,
        requestId: `direct-${directNavigationSequenceRef.current + 1}`,
      };
      directNavigationSequenceRef.current += 1;
      activeNavigationRequestRef.current = request;
      activeNavigationSourceRef.current = "direct";
      navigationKeyRef.current = responseAnnotationNavigationKey(request);
      pendingNavigationKeyRef.current = null;
      stopNavigationObservation();
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
        navigationFrameRef.current = null;
      }
      resolveNavigation(request, 3);
    },
    [resolveNavigation],
  );

  useEffect(() => {
    let shouldResolve = false;
    if (navigationRequest) {
      const key = responseAnnotationNavigationKey(navigationRequest);
      const activeRequest = activeNavigationRequestRef.current;
      if (
        activeRequest === null ||
        activeNavigationSourceRef.current !== "prop" ||
        responseAnnotationNavigationKey(activeRequest) !== key
      ) {
        activeNavigationRequestRef.current = navigationRequest;
        activeNavigationSourceRef.current = "prop";
        navigationKeyRef.current = key;
        pendingNavigationKeyRef.current = null;
        stopNavigationObservation();
        shouldResolve = true;
        if (navigationFrameRef.current !== null) {
          cancelAnimationFrame(navigationFrameRef.current);
          navigationFrameRef.current = null;
        }
      }
    } else if (activeNavigationSourceRef.current === "prop") {
      activeNavigationRequestRef.current = null;
      activeNavigationSourceRef.current = null;
      navigationKeyRef.current = null;
      pendingNavigationKeyRef.current = null;
      stopNavigationObservation();
      if (navigationFrameRef.current !== null) {
        cancelAnimationFrame(navigationFrameRef.current);
        navigationFrameRef.current = null;
      }
    }

    const activeRequest = activeNavigationRequestRef.current;
    if (!activeRequest) return;
    const key = responseAnnotationNavigationKey(activeRequest);
    if (
      !shouldResolve &&
      navigationKeyRef.current === key &&
      pendingNavigationKeyRef.current !== key
    ) {
      return;
    }
    navigationKeyRef.current = key;
    resolveNavigation(activeRequest, 3);
  }, [navigationRequest, navigationRetrySignal, resolveNavigation]);

  const refreshEditorAnchorFromMarker = useCallback((annotationId: ResponseAnnotationId) => {
    const currentEditor = editorRef.current;
    if (!currentEditor || currentEditor.annotation.id !== annotationId) return;
    const marker = timelineRootRef.current?.querySelector<HTMLElement>(
      `[data-response-annotation-marker="${annotationId}"]`,
    );
    const markerRect = marker?.getBoundingClientRect();
    if (!markerRect || (markerRect.width === 0 && markerRect.height === 0)) return;
    const nextAnchorRect = responseAnnotationRectFromDomRect(markerRect);
    setEditor((existing) => {
      if (!existing || existing.annotation.id !== annotationId) return existing;
      const previous = existing.anchorRect;
      if (
        previous.top === nextAnchorRect.top &&
        previous.left === nextAnchorRect.left &&
        previous.width === nextAnchorRect.width &&
        previous.height === nextAnchorRect.height
      ) {
        return existing;
      }
      return { ...existing, anchorRect: nextAnchorRect };
    });
  }, []);

  const contextValue = useMemo<ResponseAnnotationTimelineContextValue>(
    () => ({
      sourceMarkersByMessageId,
      onMarkerSelect: handleMarkerSelect,
      onMarkerLayout: refreshEditorAnchorFromMarker,
      onResponseAnnotationClick: handleResponseAnnotationClick,
    }),
    [
      handleMarkerSelect,
      handleResponseAnnotationClick,
      refreshEditorAnchorFromMarker,
      sourceMarkersByMessageId,
    ],
  );

  const editorAnnotation = editor
    ? editor.editable
      ? (effectiveAnnotations.find((annotation) => annotation.id === editor.annotation.id) ??
        editor.annotation)
      : editor.annotation
    : null;

  useEffect(() => {
    if (
      editor?.editable === true &&
      !effectiveAnnotations.some((annotation) => annotation.id === editor.annotation.id)
    ) {
      setEditor(null);
    }
  }, [editor, effectiveAnnotations]);

  return (
    <responseAnnotationTimelineContext.Provider value={contextValue}>
      <div
        ref={timelineRootRef}
        className="contents"
        data-response-annotation-timeline="true"
        {...(supported ? { onPointerDownCapture: handlePointerDownCapture } : {})}
      >
        {children}
      </div>
      {supported && selection ? (
        <ResponseAnnotationSelectionAction
          rect={selection.rect}
          disabled={!canCreateResponseAnnotation(effectiveAnnotations.length)}
          onAnnotate={createFromSelection}
        />
      ) : null}
      {editor && editorAnnotation ? (
        <ResponseAnnotationEditor
          annotation={editorAnnotation}
          number={
            editor.editable
              ? (numberByAnnotationId.get(editorAnnotation.id) ?? editor.number)
              : editor.number
          }
          editable={editor.editable}
          anchorRect={editor.anchorRect}
          onCancel={() => closeEditor(editorAnnotation.id)}
          onDelete={
            editor.editable
              ? () => {
                  onDeleteResponseAnnotation?.(editorAnnotation.id);
                  setDeletedAnnotationIds((existing) => {
                    const next = new Set(existing);
                    next.add(editorAnnotation.id);
                    return next;
                  });
                  setOptimisticAnnotations((existing) =>
                    existing.filter((annotation) => annotation.id !== editorAnnotation.id),
                  );
                  setEditor(null);
                  restoreSourceFocus(editorAnnotation);
                }
              : undefined
          }
          onSave={
            editor.editable
              ? (comment) => {
                  onUpdateResponseAnnotation?.(editorAnnotation.id, comment);
                  setOptimisticAnnotations((existing) =>
                    existing.map((annotation) =>
                      annotation.id === editorAnnotation.id
                        ? { ...annotation, comment }
                        : annotation,
                    ),
                  );
                  closeEditor(editorAnnotation.id);
                }
              : undefined
          }
        />
      ) : null}
      {historicalJump ? (
        <HistoricalResponseAnnotationJump
          annotation={historicalJump.annotation}
          number={historicalJump.number}
          rects={historicalJump.rects}
          showMarker={historicalJump.showMarker}
        />
      ) : null}
    </responseAnnotationTimelineContext.Provider>
  );
}

/**
 * Attach a source root around a rendered assistant response. Markers are
 * intentionally siblings of `.chat-markdown`, keeping controls out of the
 * rendered-text coordinate space used by selectors.
 */
export function ResponseAnnotationSourceRoot({
  messageId,
  streaming,
  selectable = true,
  children,
}: {
  readonly messageId: MessageId;
  readonly streaming: boolean;
  readonly selectable?: boolean;
  readonly children: ReactNode;
}) {
  const { sourceMarkersByMessageId } = useResponseAnnotationTimelineContext();
  const markers = sourceMarkersByMessageId.get(messageId) ?? [];
  const renderedChildren =
    markers.length > 0 && isValidElement<{ className?: string }>(children)
      ? cloneElement(children, {
          className: cn(children.props.className, "pt-6 pr-6"),
        })
      : children;
  return (
    <div
      className="relative min-w-0"
      data-response-annotation-source="true"
      data-response-annotation-message-id={messageId}
      data-response-annotation-streaming={streaming ? "true" : "false"}
      data-response-annotation-selectable={selectable ? "true" : "false"}
      tabIndex={-1}
    >
      {renderedChildren}
      {markers.length > 0 ? (
        <ResponseAnnotationSourceMarkers markers={markers} sourceMessageId={messageId} />
      ) : null}
    </div>
  );
}

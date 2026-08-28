import {
  RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS,
  type ResponseAnnotationSourceRange,
} from "@t3tools/contracts";

export interface RenderedTextSegment {
  readonly node: Text;
  /** UTF-16 offset of this node's first code unit in the rendered index. */
  readonly start: number;
  /** UTF-16 offset immediately after this node's last code unit. */
  readonly end: number;
}

export interface RenderedTextIndex {
  readonly text: string;
  readonly segments: ReadonlyArray<RenderedTextSegment>;
}

export interface ResolvedTextSelector {
  readonly start: number;
  readonly end: number;
}

const SKIPPED_TEXT_ANCESTORS = new Set([
  "BUTTON",
  "INPUT",
  "NOSCRIPT",
  "SCRIPT",
  "SELECT",
  "STYLE",
  "TEMPLATE",
  "SVG",
  "TEXTAREA",
]);

/**
 * These are the elements for which the browser creates a line boundary when
 * it turns a DOM subtree into selectable text.  Keep this list semantic: the
 * markdown renderer uses custom wrappers around tables and code blocks, but
 * those wrappers still contain the standard block elements below.
 */
const BLOCK_TEXT_ELEMENTS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "CAPTION",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HGROUP",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const TABLE_CELL_ELEMENTS = new Set(["TD", "TH"]);
const CODE_LINE_CLASS_NAME = "line";

function isElement(node: Node): node is Element {
  return node.nodeType === 1;
}

function elementTagName(node: Node): string {
  return isElement(node) ? node.tagName.toUpperCase() : "";
}

function hasClass(element: Element, className: string): boolean {
  return element.classList?.contains(className) ?? false;
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TEXT_ANCESTORS.has(elementTagName(element))) return true;
  // Markdown chrome (code-block headers, table actions, and similar UI) is
  // intentionally select-none. It is visible, but it cannot be part of a
  // user selection and therefore must not shift annotation coordinates.
  if (hasClass(element, "select-none")) return true;
  return element.getAttribute?.("aria-hidden") === "true";
}

function isInsideTag(node: Node, tagName: string): boolean {
  let current: Node | null = node;
  while (current) {
    if (elementTagName(current) === tagName) return true;
    current = current.parentNode;
  }
  return false;
}

function isCodeLine(node: Node): boolean {
  return (
    isElement(node) &&
    hasClass(node, CODE_LINE_CLASS_NAME) &&
    isInsideTag(node.parentNode ?? node, "PRE")
  );
}

function hasRenderedContent(node: Node, insideSkippedAncestor: boolean): boolean {
  if (node.nodeType === 3) return !insideSkippedAncestor && (node.nodeValue ?? "").length > 0;
  if (!isElement(node)) return false;
  if (insideSkippedAncestor || isSkippedElement(node)) return false;
  if (TABLE_CELL_ELEMENTS.has(elementTagName(node))) return true;
  // Empty Shiki line spans are still visible lines. Keeping them as content
  // lets two synthetic line separators represent a blank code line.
  if (isCodeLine(node)) return true;
  if (elementTagName(node) === "BR") return true;
  return Array.from(node.childNodes).some((child) => hasRenderedContent(child, false));
}

function appendSeparator(
  text: string,
  separator: string,
  allowAtStart = false,
  force = false,
): string {
  if (text.length === 0 && !allowAtStart) return text;
  // A literal newline at the end of a code line or block already represents
  // the same visual boundary. Avoid manufacturing a second one when the
  // renderer has supplied both a text newline and a block element boundary.
  if (!force && separator === "\n" && text.endsWith("\n")) return text;
  if (!force && separator === "\t" && text.endsWith("\t")) return text;
  return `${text}${separator}`;
}

function separatorBetweenChildren(parent: Node, previous: Node, next: Node): string | null {
  if (elementTagName(parent) === "TR") {
    if (
      TABLE_CELL_ELEMENTS.has(elementTagName(previous)) &&
      TABLE_CELL_ELEMENTS.has(elementTagName(next))
    ) {
      return "\t";
    }
    return null;
  }

  // Shiki emits one `.line` span per source line. Most versions put literal
  // newlines between those spans, but retaining this fallback keeps the index
  // correct during streaming and for plain test/fallback markup.
  if (isCodeLine(previous) && isCodeLine(next)) return "\n";

  if (
    (isElement(previous) && elementTagName(previous) === "BR") ||
    (isElement(next) && elementTagName(next) === "BR")
  ) {
    return null;
  }

  const previousIsBlock = isElement(previous) && BLOCK_TEXT_ELEMENTS.has(elementTagName(previous));
  const nextIsBlock = isElement(next) && BLOCK_TEXT_ELEMENTS.has(elementTagName(next));
  return previousIsBlock || nextIsBlock ? "\n" : null;
}

/**
 * Build the text coordinate space used by response annotations.
 *
 * JavaScript string offsets are UTF-16 offsets, matching DOM Range offsets and
 * the contract's persisted `sourceRange`. Text nodes are collected in DOM
 * order. Generated annotation links are included as ordinary rendered text;
 * the timeline can choose a narrower root when it needs to exclude controls.
 */
export function buildRenderedTextIndex(root: Node): RenderedTextIndex {
  const segments: RenderedTextSegment[] = [];
  let text = "";

  const visit = (node: Node, insideSkippedAncestor: boolean) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue ?? "";
      if (!insideSkippedAncestor && value.length > 0) {
        const start = text.length;
        text += value;
        segments.push({ node: node as Text, start, end: text.length });
      }
      return;
    }
    if (!isElement(node)) {
      node.childNodes.forEach((child) => visit(child, insideSkippedAncestor));
      return;
    }
    if (insideSkippedAncestor || isSkippedElement(node)) return;
    if (elementTagName(node) === "BR") {
      text = appendSeparator(text, "\n", true, true);
      return;
    }

    let previousChild: Node | null = null;
    node.childNodes.forEach((child) => {
      if (!hasRenderedContent(child, false)) return;
      if (previousChild) {
        const separator = separatorBetweenChildren(node, previousChild, child);
        if (separator) {
          const forceCodeLineSeparator =
            separator === "\n" && isCodeLine(previousChild) && isCodeLine(child);
          const forceTableCellSeparator =
            separator === "\t" &&
            elementTagName(node) === "TR" &&
            TABLE_CELL_ELEMENTS.has(elementTagName(previousChild)) &&
            TABLE_CELL_ELEMENTS.has(elementTagName(child));
          text = appendSeparator(
            text,
            separator,
            forceCodeLineSeparator || forceTableCellSeparator,
            forceCodeLineSeparator || forceTableCellSeparator,
          );
        }
      }
      visit(child, false);
      previousChild = child;
    });
  };

  visit(root, false);
  return { text, segments };
}

/** Build the persisted source-range selector from absolute UTF-16 offsets. */
export function buildResponseAnnotationSourceRange(
  renderedText: string,
  start: number,
  end: number,
  contextLength = RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS,
): ResponseAnnotationSourceRange | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end > renderedText.length
  ) {
    return null;
  }
  const boundedContextLength = Math.max(
    0,
    Math.min(RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS, Math.floor(contextLength)),
  );
  return {
    start,
    end,
    prefix: renderedText.slice(Math.max(0, start - boundedContextLength), start),
    suffix: renderedText.slice(end, end + boundedContextLength),
  };
}

/**
 * Resolve a persisted selector against a newer rendered text value.
 *
 * The stored offsets are tried first, but only when their surrounding context
 * still matches. If the response moved or repeated text changed the offsets,
 * all occurrences are searched and the context selects the intended one.
 */
export function resolveResponseAnnotationSourceRange(
  renderedText: string,
  selectedText: string,
  selector: Pick<ResponseAnnotationSourceRange, "start" | "end" | "prefix" | "suffix">,
): ResolvedTextSelector | null {
  const selectedLength = selector.end - selector.start;
  if (
    selectedText.length === 0 ||
    selectedText.length !== selectedLength ||
    !Number.isSafeInteger(selector.start) ||
    !Number.isSafeInteger(selector.end) ||
    selector.start < 0 ||
    selectedLength <= 0
  ) {
    return null;
  }

  const matchesAt = (start: number, requireContext: boolean): boolean => {
    const end = start + selectedLength;
    if (renderedText.slice(start, end) !== selectedText) return false;
    if (!requireContext) return true;
    return (
      renderedText.slice(Math.max(0, start - selector.prefix.length), start) === selector.prefix &&
      renderedText.slice(end, end + selector.suffix.length) === selector.suffix
    );
  };

  const hasContext = selector.prefix.length > 0 || selector.suffix.length > 0;
  if (matchesAt(selector.start, hasContext)) {
    return { start: selector.start, end: selector.end };
  }

  if (selectedText.length === 0) return null;
  let searchStart = 0;
  while (searchStart <= renderedText.length - selectedText.length) {
    const candidate = renderedText.indexOf(selectedText, searchStart);
    if (candidate === -1) break;
    if (matchesAt(candidate, selector.prefix.length > 0 || selector.suffix.length > 0)) {
      return { start: candidate, end: candidate + selectedText.length };
    }
    searchStart = candidate + 1;
  }

  // If surrounding prose changed, a unique occurrence is still unambiguous.
  // Repeated text continues to require the stored prefix and suffix.
  const onlyCandidate = renderedText.indexOf(selectedText);
  if (
    onlyCandidate >= 0 &&
    renderedText.indexOf(selectedText, onlyCandidate + selectedText.length) === -1
  ) {
    return { start: onlyCandidate, end: onlyCandidate + selectedText.length };
  }
  return null;
}

/** Resolve a selector when the persisted selected text is available. */
export function resolveResponseAnnotationSourceRangeWithText(
  renderedText: string,
  selectedText: string,
  selector: Pick<ResponseAnnotationSourceRange, "start" | "end" | "prefix" | "suffix">,
): ResolvedTextSelector | null {
  return resolveResponseAnnotationSourceRange(renderedText, selectedText, selector);
}

/** Convert a DOM Range into the same UTF-16 coordinate space. */
export function responseAnnotationSourceRangeFromDomRange(
  range: Range,
  index: RenderedTextIndex,
): ResponseAnnotationSourceRange | null {
  if (range.collapsed) return null;
  const start = absoluteOffsetForBoundary(range.startContainer, range.startOffset, index, "start");
  const end = absoluteOffsetForBoundary(range.endContainer, range.endOffset, index, "end");
  if (start === null || end === null || end <= start) return null;
  return buildResponseAnnotationSourceRange(index.text, start, end);
}

/** Find the DOM Range represented by a persisted selector. */
export function domRangeForResponseAnnotation(
  root: Node,
  selectedText: string,
  selector: Pick<ResponseAnnotationSourceRange, "start" | "end" | "prefix" | "suffix">,
): Range | null {
  const index = buildRenderedTextIndex(root);
  const resolved = resolveResponseAnnotationSourceRangeWithText(index.text, selectedText, selector);
  if (!resolved) return null;
  const range = root.ownerDocument?.createRange();
  if (!range) return null;
  const startBoundary = domBoundaryForOffset(resolved.start, index);
  const endBoundary = domBoundaryForOffset(resolved.end, index);
  if (!startBoundary || !endBoundary) return null;
  range.setStart(startBoundary.node, startBoundary.offset);
  range.setEnd(endBoundary.node, endBoundary.offset);
  return range;
}

function absoluteOffsetForBoundary(
  container: Node,
  offset: number,
  index: RenderedTextIndex,
  side: "start" | "end",
): number | null {
  const segment = index.segments.find((candidate) => candidate.node === container);
  if (segment) {
    const boundedOffset = Number.isFinite(offset)
      ? Math.max(0, Math.min(segment.end - segment.start, Math.trunc(offset)))
      : 0;
    return boundedOffset + segment.start;
  }

  // A Range can use an element as a boundary. Locate the first text node at
  // or after that child offset; this keeps selections made by keyboard and
  // mouse equivalent when a block contains nested emphasis or links.
  const descendants = index.segments.filter((candidate) => container.contains(candidate.node));
  if (descendants.length === 0) return null;
  // Keep this as Node[] rather than the DOM library's ChildNode[] so the
  // boundary walk can use the same Node type as Range containers.
  const childNodes: Node[] = Array.from(container.childNodes);
  const clampedOffset = Number.isFinite(offset)
    ? Math.max(0, Math.min(childNodes.length, Math.trunc(offset)))
    : 0;
  if (clampedOffset === 0) return descendants[0]!.start;
  if (clampedOffset === childNodes.length) return descendants.at(-1)!.end;

  // A synthetic separator lives between the previous and next text segments.
  // A range start at an element boundary belongs to the next child, while a
  // range end at that same boundary belongs to the previous child. This keeps
  // element-boundary ranges from accidentally swallowing a block separator.
  const childIndexFor = (candidate: RenderedTextSegment): number => {
    let current: Node = candidate.node;
    while (current.parentNode && current.parentNode !== container) {
      current = current.parentNode;
    }
    return current.parentNode === container ? childNodes.indexOf(current) : -1;
  };
  const atOrAfter = descendants.find((candidate) => childIndexFor(candidate) >= clampedOffset);
  const previous = descendants.findLast((candidate) => childIndexFor(candidate) < clampedOffset);
  if (side === "start") return atOrAfter?.start ?? previous?.end ?? null;
  return previous?.end ?? atOrAfter?.start ?? null;
}

function domBoundaryForOffset(
  offset: number,
  index: RenderedTextIndex,
): { node: Text; offset: number } | null {
  if (index.segments.length === 0) return null;
  const containing = index.segments.find(
    (segment) => offset >= segment.start && offset <= segment.end,
  );
  if (containing) {
    return { node: containing.node, offset: offset - containing.start };
  }
  const last = index.segments.at(-1)!;
  return { node: last.node, offset: last.end - last.start };
}

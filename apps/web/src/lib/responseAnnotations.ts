import {
  MessageId,
  ResponseAnnotationId,
  RESPONSE_ANNOTATION_MAX_COMMENT_CHARS,
  RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS,
  RESPONSE_ANNOTATION_MAX_COUNT,
  RESPONSE_ANNOTATION_MAX_SELECTED_TEXT_CHARS,
  type ResponseAnnotation,
} from "@t3tools/contracts";
import {
  parseResponseAnnotationDirective,
  splitResponseAnnotationDirectives,
} from "@t3tools/shared/responseAnnotations";
import { randomUUID } from "./utils";

export {
  buildRenderedTextIndex,
  buildResponseAnnotationSourceRange,
  domRangeForResponseAnnotation,
  resolveResponseAnnotationSourceRange,
  resolveResponseAnnotationSourceRangeWithText,
  responseAnnotationSourceRangeFromDomRange,
} from "./responseAnnotationSelector";
export type {
  RenderedTextIndex,
  RenderedTextSegment,
  ResolvedTextSelector,
} from "./responseAnnotationSelector";

export type { ResponseAnnotation } from "@t3tools/contracts";

/** The fragment used by generated links before the markdown renderer handles them. */
export const CODEX_RESPONSE_ANNOTATION_HREF_PREFIX = "#t3-codex-response-annotation-";

export interface ParsedCodexResponseAnnotationDirective {
  /** The one-based index as written by the provider. */
  readonly rawIndex: string;
  /** `null` means the number is outside JavaScript's safe integer range. */
  readonly index: number | null;
}

export function codexResponseAnnotationHref(rawIndex: string): string {
  return `${CODEX_RESPONSE_ANNOTATION_HREF_PREFIX}${encodeURIComponent(rawIndex)}`;
}

export function parseCodexResponseAnnotationHref(
  href: string | undefined,
): ParsedCodexResponseAnnotationDirective | null {
  if (!href?.startsWith(CODEX_RESPONSE_ANNOTATION_HREF_PREFIX)) return null;
  const encodedIndex = href.slice(CODEX_RESPONSE_ANNOTATION_HREF_PREFIX.length);
  let rawIndex: string;
  try {
    rawIndex = decodeURIComponent(encodedIndex);
  } catch {
    return null;
  }
  if (!/^[0-9]+$/.test(rawIndex)) return null;
  return parseResponseAnnotationDirective(`:codex-annotation{index="${rawIndex}"}`);
}

/** Resolve a one-based provider index against the initiating user message. */
export function resolveCodexResponseAnnotation(
  directive: ParsedCodexResponseAnnotationDirective,
  annotations: ReadonlyArray<ResponseAnnotation>,
): ResponseAnnotation | null {
  if (directive.index === null || directive.index < 1) return null;
  return annotations[directive.index - 1] ?? null;
}

/**
 * Convert text nodes in an mdast tree into links. The traversal only rewrites
 * `text` nodes, so inline code and fenced code (`inlineCode` and `code`) stay
 * byte-for-byte literal. Existing links are skipped to avoid generating
 * nested anchors.
 */
export function remarkCodexResponseAnnotations() {
  return (tree: MarkdownAnnotationAstNode, file?: MarkdownAnnotationVFile) => {
    const source = file?.toString();
    const visit = (node: MarkdownAnnotationAstNode) => {
      if (!node.children) return;
      const insideLink = node.type === "link" || node.type === "linkReference";
      const nextChildren: MarkdownAnnotationAstNode[] = [];
      for (const child of node.children) {
        if (!insideLink && child.type === "text" && typeof child.value === "string") {
          const parts = splitResponseAnnotationDirectives(child.value);
          if (parts.length > 1 || parts[0]?.kind === "directive") {
            const escapedDirectiveOrdinals = findEscapedDirectiveOrdinals(
              child.value,
              child.position,
              source,
            );
            let directiveOrdinal = 0;
            nextChildren.push(
              ...parts.map((part) => {
                if (part.kind === "text") {
                  return { type: "text", value: part.value };
                }

                const isEscaped = escapedDirectiveOrdinals.has(directiveOrdinal);
                directiveOrdinal += 1;
                if (isEscaped) {
                  return {
                    type: "text",
                    value: `:codex-annotation{index="${part.directive.rawIndex}"}`,
                  };
                }

                return {
                  type: "link",
                  title: null,
                  url: codexResponseAnnotationHref(part.directive.rawIndex),
                  data: {
                    hProperties: {
                      dataCodexResponseAnnotation: part.directive.rawIndex,
                    },
                  },
                  children: [{ type: "text", value: `Annotation ${part.directive.rawIndex}` }],
                };
              }),
            );
            continue;
          }
        }
        if (!insideLink) visit(child);
        nextChildren.push(child);
      }
      node.children = nextChildren;
    };

    visit(tree);
  };
}

type MarkdownAnnotationVFile = {
  toString: () => string;
};

const CODEX_RESPONSE_ANNOTATION_SOURCE_PATTERN = /:codex-annotation\{index="([0-9]+)"\}/g;

function findEscapedDirectiveOrdinals(
  value: string,
  position: MarkdownAnnotationAstNode["position"],
  source: string | undefined,
): ReadonlySet<number> {
  if (source === undefined) return new Set();

  const startOffset = position?.start?.offset;
  const endOffset = position?.end?.offset;
  const valueMatches = [...value.matchAll(CODEX_RESPONSE_ANNOTATION_SOURCE_PATTERN)];
  if (
    typeof startOffset !== "number" ||
    typeof endOffset !== "number" ||
    !Number.isSafeInteger(startOffset) ||
    !Number.isSafeInteger(endOffset) ||
    startOffset < 0 ||
    endOffset < startOffset
  ) {
    return new Set(valueMatches.map((_, ordinal) => ordinal));
  }

  const sourceValue = source.slice(startOffset, endOffset);
  const sourceMatches = [...sourceValue.matchAll(CODEX_RESPONSE_ANNOTATION_SOURCE_PATTERN)];
  if (
    sourceMatches.length !== valueMatches.length ||
    sourceMatches.some((match, ordinal) => match[1] !== valueMatches[ordinal]?.[1])
  ) {
    return new Set(valueMatches.map((_, ordinal) => ordinal));
  }

  const escapedOrdinals = new Set<number>();
  for (const [ordinal, match] of sourceMatches.entries()) {
    const relativeOffset = match.index;
    if (relativeOffset === undefined) continue;
    let slashCount = 0;
    for (
      let offset = startOffset + relativeOffset - 1;
      offset >= 0 && source[offset] === "\\";
      offset -= 1
    ) {
      slashCount += 1;
    }
    if (slashCount % 2 === 1) escapedOrdinals.add(ordinal);
  }
  return escapedOrdinals;
}

type MarkdownAnnotationAstNode = {
  type?: string;
  value?: string;
  title?: string | null;
  url?: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
  data?: {
    hProperties?: Record<string, string>;
  };
  children?: MarkdownAnnotationAstNode[];
};

/**
 * Normalize user-created or persisted annotation data before it enters the
 * local store. The contract validates the same bounds on the wire; keeping
 * this guard here prevents malformed localStorage data from escaping into an
 * optimistic message.
 */
export function normalizeResponseAnnotation(value: unknown): ResponseAnnotation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const sourceRange = candidate.sourceRange;
  if (!sourceRange || typeof sourceRange !== "object") return null;
  const range = sourceRange as Record<string, unknown>;
  const id = typeof candidate.id === "string" ? candidate.id.trim() : "";
  const sourceMessageId =
    typeof candidate.sourceMessageId === "string" ? candidate.sourceMessageId.trim() : "";
  const selectedText = typeof candidate.selectedText === "string" ? candidate.selectedText : "";
  const comment = typeof candidate.comment === "string" ? candidate.comment : "";
  const start = range.start;
  const end = range.end;
  const prefix = typeof range.prefix === "string" ? range.prefix : "";
  const suffix = typeof range.suffix === "string" ? range.suffix : "";
  if (
    id.length === 0 ||
    sourceMessageId.length === 0 ||
    selectedText.length === 0 ||
    selectedText.length > RESPONSE_ANNOTATION_MAX_SELECTED_TEXT_CHARS ||
    comment.length > RESPONSE_ANNOTATION_MAX_COMMENT_CHARS ||
    prefix.length > RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS ||
    suffix.length > RESPONSE_ANNOTATION_MAX_CONTEXT_CHARS ||
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end <= start ||
    end - start !== selectedText.length
  ) {
    return null;
  }
  return {
    id: ResponseAnnotationId.make(id),
    sourceMessageId: MessageId.make(sourceMessageId),
    selectedText,
    sourceRange: { start, end, prefix, suffix },
    comment,
  };
}

export function normalizeResponseAnnotations(value: unknown): ResponseAnnotation[] {
  if (!Array.isArray(value)) return [];
  const seenIds = new Set<string>();
  const annotations: ResponseAnnotation[] = [];
  for (const candidate of value) {
    const annotation = normalizeResponseAnnotation(candidate);
    if (!annotation || seenIds.has(annotation.id)) continue;
    annotations.push(annotation);
    seenIds.add(annotation.id);
    if (annotations.length >= RESPONSE_ANNOTATION_MAX_COUNT) break;
  }
  return annotations;
}

export function newResponseAnnotationId(): ResponseAnnotationId {
  return ResponseAnnotationId.make(`response-annotation-${randomUUID()}`);
}

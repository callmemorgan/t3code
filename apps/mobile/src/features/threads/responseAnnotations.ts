import type { MessageId, ResponseAnnotation, TurnId } from "@t3tools/contracts";
import { replaceResponseAnnotationDirectives } from "@t3tools/shared/responseAnnotations";

import type { ThreadFeedEntry } from "../../lib/threadActivity";

/** Internal link destination used by both mobile Markdown renderers. */
export const MOBILE_RESPONSE_ANNOTATION_HREF_PREFIX = "t3://response-annotation/";

export interface ResponseAnnotationTurnContext {
  readonly annotationsByTurnId: ReadonlyMap<TurnId, ReadonlyArray<ResponseAnnotation>>;
  readonly userMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
  readonly annotationsById: ReadonlyMap<string, ResponseAnnotation>;
}

function entryTurnId(entry: ThreadFeedEntry): TurnId | null {
  switch (entry.type) {
    case "message":
      return entry.message.role === "assistant" ? entry.message.turnId : null;
    case "activity-group":
    case "work-toggle":
    case "turn-fold":
      return entry.turnId;
  }
}

/**
 * Bind native annotation indexes to the turn that follows their user
 * message. User messages intentionally have no turn id of their own.
 */
export function deriveResponseAnnotationTurnContext(
  entries: ReadonlyArray<ThreadFeedEntry>,
): ResponseAnnotationTurnContext {
  const annotationsByTurnId = new Map<TurnId, ReadonlyArray<ResponseAnnotation>>();
  const userMessageIdByTurnId = new Map<TurnId, MessageId>();
  const annotationsById = new Map<string, ResponseAnnotation>();
  let pendingUser: {
    readonly messageId: MessageId;
    readonly annotations: ReadonlyArray<ResponseAnnotation>;
  } | null = null;

  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") {
      for (const annotation of entry.message.responseAnnotations ?? []) {
        annotationsById.set(annotation.id, annotation);
      }
      pendingUser = {
        messageId: entry.message.id,
        annotations: entry.message.responseAnnotations ?? [],
      };
      continue;
    }

    const turnId = entryTurnId(entry);
    if (turnId === null || annotationsByTurnId.has(turnId)) {
      continue;
    }
    if (pendingUser === null) {
      annotationsByTurnId.set(turnId, []);
      continue;
    }
    annotationsByTurnId.set(turnId, pendingUser.annotations);
    userMessageIdByTurnId.set(turnId, pendingUser.messageId);
    pendingUser = null;
  }

  return { annotationsByTurnId, userMessageIdByTurnId, annotationsById };
}

export function responseAnnotationHref(index: number, annotationId: string): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError("Annotation index must be a positive safe integer.");
  }
  if (annotationId.length === 0) {
    throw new RangeError("Annotation id must not be empty.");
  }
  return `${MOBILE_RESPONSE_ANNOTATION_HREF_PREFIX}${index}/${encodeURIComponent(annotationId)}`;
}

export interface MobileResponseAnnotationReference {
  readonly index: number;
  readonly annotationId: string;
}

export function responseAnnotationReferenceFromHref(
  href: string,
): MobileResponseAnnotationReference | null {
  if (!href.startsWith(MOBILE_RESPONSE_ANNOTATION_HREF_PREFIX)) {
    return null;
  }
  const remainder = href.slice(MOBILE_RESPONSE_ANNOTATION_HREF_PREFIX.length);
  const separator = remainder.indexOf("/");
  if (separator <= 0 || separator === remainder.length - 1) return null;
  const rawIndex = remainder.slice(0, separator);
  if (!/^[1-9][0-9]*$/.test(rawIndex)) {
    return null;
  }
  const index = Number(rawIndex);
  if (!Number.isSafeInteger(index)) return null;
  try {
    const annotationId = decodeURIComponent(remainder.slice(separator + 1));
    return annotationId.length > 0 ? { index, annotationId } : null;
  } catch {
    return null;
  }
}

export function responseAnnotationIndexFromHref(href: string): number | null {
  return responseAnnotationReferenceFromHref(href)?.index ?? null;
}

/**
 * Prepare assistant Markdown for the native and JS mobile renderers. The
 * shared scanner deliberately leaves malformed directives and code examples
 * byte-for-byte unchanged. A valid but out-of-range index is made readable
 * without a link, since there is no source annotation to activate.
 */
export function prepareResponseAnnotationMarkdown(
  markdown: string,
  annotations: ReadonlyArray<ResponseAnnotation>,
): string {
  return replaceResponseAnnotationDirectives(markdown, ({ index, rawIndex }) => {
    if (index === null || index < 1 || annotations[index - 1] === undefined) {
      return `Annotation ${rawIndex}`;
    }
    return `[Annotation ${index}](${responseAnnotationHref(index, annotations[index - 1]!.id)})`;
  });
}

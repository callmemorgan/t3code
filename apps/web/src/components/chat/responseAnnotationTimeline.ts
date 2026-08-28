import type { MessageId, ResponseAnnotation, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";

export interface ResponseAnnotationTurnContext {
  readonly annotationsByTurnId: ReadonlyMap<TurnId, ReadonlyArray<ResponseAnnotation>>;
  readonly userMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
  readonly annotationsById: ReadonlyMap<ResponseAnnotation["id"], ResponseAnnotation>;
}

function entryTurnId(entry: TimelineEntry): TurnId | null {
  switch (entry.kind) {
    case "message":
      return entry.message.role === "assistant" ? entry.message.turnId : null;
    case "work":
      return entry.entry.turnId ?? null;
    case "proposed-plan":
      return entry.proposedPlan.turnId;
    case "turn-plan":
      return entry.turnPlan.turnId;
  }
}

/**
 * User messages do not have a turn id. The first turn-scoped entry after a
 * user message establishes the association used by native annotation indexes.
 */
export function deriveResponseAnnotationTurnContext(
  entries: ReadonlyArray<TimelineEntry>,
): ResponseAnnotationTurnContext {
  const annotationsByTurnId = new Map<TurnId, ReadonlyArray<ResponseAnnotation>>();
  const userMessageIdByTurnId = new Map<TurnId, MessageId>();
  const annotationsById = new Map<ResponseAnnotation["id"], ResponseAnnotation>();
  let pendingUser: {
    readonly messageId: MessageId;
    readonly annotations: ReadonlyArray<ResponseAnnotation>;
  } | null = null;

  for (const entry of entries) {
    if (entry.kind === "message" && entry.message.role === "user") {
      const annotations = entry.message.responseAnnotations ?? [];
      for (const annotation of annotations) annotationsById.set(annotation.id, annotation);
      pendingUser = { messageId: entry.message.id, annotations };
      continue;
    }

    const turnId = entryTurnId(entry);
    if (turnId === null || annotationsByTurnId.has(turnId)) continue;
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

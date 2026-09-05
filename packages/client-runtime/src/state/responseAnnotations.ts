import type {
  MessageId,
  OrchestrationMessage,
  ResponseAnnotation,
  TurnId,
} from "@t3tools/contracts";

/**
 * The turn-scoped annotation indexes used by chat timelines and renderers.
 *
 * A user message is eligible only after the server has bound its provider turn
 * id. This keeps a queued message from borrowing the first later turn that
 * happens to appear in a partially loaded timeline.
 */
export interface ResponseAnnotationTurnContext {
  readonly annotationsByTurnId: ReadonlyMap<TurnId, ReadonlyArray<ResponseAnnotation>>;
  readonly userMessageIdByTurnId: ReadonlyMap<TurnId, MessageId>;
  readonly annotationsById: ReadonlyMap<ResponseAnnotation["id"], ResponseAnnotation>;
}

/** The stable result returned when no sent user message has bound annotations. */
export const EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT: ResponseAnnotationTurnContext = {
  annotationsByTurnId: new Map(),
  userMessageIdByTurnId: new Map(),
  annotationsById: new Map(),
};

interface BoundAnnotationSource {
  readonly message: OrchestrationMessage;
  readonly turnId: TurnId;
  readonly annotations: ReadonlyArray<ResponseAnnotation>;
}

function collectBoundAnnotationSources(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<BoundAnnotationSource> {
  const sources: BoundAnnotationSource[] = [];
  for (const message of messages) {
    if (message.role !== "user" || message.turnId === null) {
      continue;
    }
    const annotations = message.responseAnnotations;
    if (annotations === undefined || annotations.length === 0) {
      continue;
    }
    sources.push({ message, turnId: message.turnId, annotations });
  }
  return sources;
}

function boundSourcesEqual(
  left: ReadonlyArray<BoundAnnotationSource>,
  right: ReadonlyArray<BoundAnnotationSource>,
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (source, index) =>
        source.message === right[index]?.message &&
        source.turnId === right[index]?.turnId &&
        source.annotations === right[index]?.annotations,
    )
  );
}

function buildResponseAnnotationTurnContext(
  sources: ReadonlyArray<BoundAnnotationSource>,
): ResponseAnnotationTurnContext {
  if (sources.length === 0) {
    return EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT;
  }

  const annotationsByTurnId = new Map<TurnId, ReadonlyArray<ResponseAnnotation>>();
  const userMessageIdByTurnId = new Map<TurnId, MessageId>();
  const annotationsById = new Map<ResponseAnnotation["id"], ResponseAnnotation>();
  const ambiguousTurnIds = new Set<TurnId>();

  for (const source of sources) {
    // Older clients could send two annotation batches while steering one
    // provider turn. Number-only references cannot distinguish those batches.
    const previousMessageId = userMessageIdByTurnId.get(source.turnId);
    if (previousMessageId !== undefined && previousMessageId !== source.message.id) {
      ambiguousTurnIds.add(source.turnId);
      annotationsByTurnId.delete(source.turnId);
      userMessageIdByTurnId.delete(source.turnId);
    } else if (!ambiguousTurnIds.has(source.turnId)) {
      annotationsByTurnId.set(source.turnId, source.annotations);
      userMessageIdByTurnId.set(source.turnId, source.message.id);
    }
    for (const annotation of source.annotations) {
      annotationsById.set(annotation.id, annotation);
    }
  }

  return { annotationsByTurnId, userMessageIdByTurnId, annotationsById };
}

/**
 * Creates a selector that reuses all derived references when only assistant
 * messages (including streaming deltas) changed. The selector compares the
 * bound user-message source objects, so callers may pass a newly allocated
 * message array on every reducer update without causing timeline churn.
 *
 * Create one selector per timeline instance so unrelated threads do not
 * invalidate each other.
 */
export function createResponseAnnotationTurnContextSelector(): (
  messages: ReadonlyArray<OrchestrationMessage>,
) => ResponseAnnotationTurnContext {
  let previousSources: ReadonlyArray<BoundAnnotationSource> = [];
  let previousResult = EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT;

  return (messages) => {
    const sources = collectBoundAnnotationSources(messages);
    if (boundSourcesEqual(previousSources, sources)) {
      return previousResult;
    }
    previousSources = sources;
    previousResult = buildResponseAnnotationTurnContext(sources);
    return previousResult;
  };
}

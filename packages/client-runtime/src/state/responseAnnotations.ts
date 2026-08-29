import type {
  MessageId,
  OrchestrationMessage,
  ResponseAnnotation,
  TurnId,
} from "@t3tools/contracts";

/** A read-only source marker for an annotation that has already been sent. */
export interface ResponseAnnotationSourceMarker {
  readonly annotation: ResponseAnnotation;
  readonly number: number;
  readonly editable: false;
}

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
  readonly sentSourceMarkers: ReadonlyArray<ResponseAnnotationSourceMarker>;
  /** Alias for callers that name the flattened collection sent annotations. */
  readonly sentAnnotations: ReadonlyArray<ResponseAnnotationSourceMarker>;
}

const EMPTY_RESPONSE_ANNOTATION_SOURCE_MARKERS: ReadonlyArray<ResponseAnnotationSourceMarker> =
  Object.freeze([]);
const EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT: ResponseAnnotationTurnContext = {
  annotationsByTurnId: new Map(),
  userMessageIdByTurnId: new Map(),
  annotationsById: new Map(),
  sentSourceMarkers: EMPTY_RESPONSE_ANNOTATION_SOURCE_MARKERS,
  sentAnnotations: EMPTY_RESPONSE_ANNOTATION_SOURCE_MARKERS,
};

/** The stable result returned when no sent user message has bound annotations. */
export { EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT };

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
  const sentSourceMarkers: ResponseAnnotationSourceMarker[] = [];

  for (const source of sources) {
    // A turn has one initiating user message. Keep the first source if a
    // malformed/replayed stream supplies a duplicate rather than silently
    // replacing a stable association with a later message.
    if (!annotationsByTurnId.has(source.turnId)) {
      annotationsByTurnId.set(source.turnId, source.annotations);
      userMessageIdByTurnId.set(source.turnId, source.message.id);
    }
    for (const [index, annotation] of source.annotations.entries()) {
      annotationsById.set(annotation.id, annotation);
      sentSourceMarkers.push({ annotation, number: index + 1, editable: false });
    }
  }

  return {
    annotationsByTurnId,
    userMessageIdByTurnId,
    annotationsById,
    sentSourceMarkers,
    sentAnnotations: sentSourceMarkers,
  };
}

/**
 * Creates a selector that reuses all derived references when only assistant
 * messages (including streaming deltas) changed. The selector compares the
 * bound user-message source objects, so callers may pass a newly allocated
 * message array on every reducer update without causing timeline churn.
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

/** Alias emphasizing that the selector indexes turn-scoped annotations. */
export const createResponseAnnotationSelector = createResponseAnnotationTurnContextSelector;

// The direct helper is useful for non-reactive consumers. Its selector is
// intentionally shared so repeated calls also retain reference identity.
const defaultResponseAnnotationTurnContextSelector = createResponseAnnotationTurnContextSelector();

export function selectResponseAnnotationTurnContext(
  messages: ReadonlyArray<OrchestrationMessage>,
): ResponseAnnotationTurnContext {
  return defaultResponseAnnotationTurnContextSelector(messages);
}

/** Compatibility name for timeline code that previously derived by entry order. */
export const deriveResponseAnnotationTurnContext = selectResponseAnnotationTurnContext;

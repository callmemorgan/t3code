import { MessageId, ResponseAnnotationId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createResponseAnnotationTurnContextSelector,
  EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT,
} from "./responseAnnotations.ts";
import type { OrchestrationMessage, ResponseAnnotation } from "@t3tools/contracts";

const timestamp = "2026-08-28T00:00:00.000Z";
const annotation: ResponseAnnotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: MessageId.make("assistant-source"),
  selectedText: "selected text",
  sourceRange: { start: 0, end: 13, prefix: "", suffix: "" },
  comment: "Check this",
};

function message(input: {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly turnId: TurnId | null;
  readonly text?: string;
  readonly streaming?: boolean;
  readonly responseAnnotations?: ReadonlyArray<ResponseAnnotation>;
}): OrchestrationMessage {
  return {
    id: MessageId.make(input.id),
    role: input.role,
    text: input.text ?? input.role,
    turnId: input.turnId,
    streaming: input.streaming ?? false,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(input.responseAnnotations !== undefined
      ? { responseAnnotations: input.responseAnnotations }
      : {}),
  };
}

describe("response annotation turn selector", () => {
  it("returns the empty singleton when annotations are absent or unbound", () => {
    const select = createResponseAnnotationTurnContextSelector();
    const unbound = message({
      id: "user-1",
      role: "user",
      turnId: null,
      responseAnnotations: [annotation],
    });

    expect(select([])).toBe(EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT);
    expect(select([unbound])).toBe(EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT);
    expect(select([unbound, message({ id: "assistant-1", role: "assistant", turnId: null })])).toBe(
      EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT,
    );
  });

  it("indexes only bound annotations", () => {
    const select = createResponseAnnotationTurnContextSelector();
    const turnId = TurnId.make("turn-1");
    const bound = message({
      id: "user-1",
      role: "user",
      turnId,
      responseAnnotations: [annotation],
    });
    const result = select([
      message({
        id: "unbound-user",
        role: "user",
        turnId: null,
        responseAnnotations: [
          { ...annotation, id: ResponseAnnotationId.make("annotation-unbound") },
        ],
      }),
      bound,
    ]);

    expect(result.annotationsByTurnId.get(turnId)).toBe(bound.responseAnnotations);
    expect(result.userMessageIdByTurnId.get(turnId)).toBe(bound.id);
    expect(result.annotationsById.get(annotation.id)).toBe(annotation);
    expect(result.annotationsById.has(ResponseAnnotationId.make("annotation-unbound"))).toBe(false);
  });

  it("reuses the result and all derived references across assistant streaming changes", () => {
    const select = createResponseAnnotationTurnContextSelector();
    const turnId = TurnId.make("turn-1");
    const user = message({
      id: "user-1",
      role: "user",
      turnId,
      responseAnnotations: [annotation],
    });
    const first = select([user, message({ id: "assistant-1", role: "assistant", turnId })]);
    const second = select([
      user,
      message({
        id: "assistant-1",
        role: "assistant",
        turnId,
        text: "streaming delta",
        streaming: true,
      }),
    ]);

    expect(second).toBe(first);
    expect(second.annotationsByTurnId).toBe(first.annotationsByTurnId);
    expect(second.userMessageIdByTurnId).toBe(first.userMessageIdByTurnId);
    expect(second.annotationsById).toBe(first.annotationsById);
  });

  it("invalidates when a user message becomes bound to a turn", () => {
    const select = createResponseAnnotationTurnContextSelector();
    const unbound = message({
      id: "user-1",
      role: "user",
      turnId: null,
      responseAnnotations: [annotation],
    });
    const empty = select([unbound]);
    const turnId = TurnId.make("turn-1");
    const bound = { ...unbound, turnId };
    const result = select([bound]);

    expect(empty).toBe(EMPTY_RESPONSE_ANNOTATION_TURN_CONTEXT);
    expect(result).not.toBe(empty);
    expect(result.annotationsByTurnId.get(turnId)).toEqual([annotation]);
    expect(result.userMessageIdByTurnId.get(turnId)).toBe(bound.id);
  });
});

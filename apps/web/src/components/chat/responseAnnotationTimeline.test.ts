import { describe, expect, it } from "vite-plus/test";
import { MessageId, ResponseAnnotationId, TurnId } from "@t3tools/contracts";

import type { TimelineEntry } from "../../session-logic";
import { deriveResponseAnnotationTurnContext } from "./responseAnnotationTimeline";

const timestamp = "2026-08-28T00:00:00.000Z";
const annotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: MessageId.make("source-1"),
  selectedText: "selected",
  sourceRange: { start: 0, end: 8, prefix: "", suffix: "" },
  comment: "comment",
};

function message(
  id: string,
  role: "user" | "assistant",
  turnId: TurnId | null,
  responseAnnotations?: ReadonlyArray<typeof annotation>,
): TimelineEntry {
  return {
    id,
    kind: "message",
    createdAt: timestamp,
    message: {
      id: MessageId.make(id),
      role,
      text: role,
      turnId,
      streaming: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(responseAnnotations ? { responseAnnotations } : {}),
    },
  };
}

describe("response annotation turn context", () => {
  it("binds annotations to the first turn after their user message", () => {
    const turnId = TurnId.make("turn-1");
    const context = deriveResponseAnnotationTurnContext([
      message("user-1", "user", null, [annotation]),
      {
        id: "work-1",
        kind: "work",
        createdAt: timestamp,
        entry: { id: "work-1", createdAt: timestamp, label: "Working", tone: "tool", turnId },
      },
      message("assistant-1", "assistant", turnId),
    ]);

    expect(context.annotationsByTurnId.get(turnId)).toEqual([annotation]);
    expect(context.userMessageIdByTurnId.get(turnId)).toBe("user-1");
    expect(context.annotationsById.get(annotation.id)).toEqual(annotation);
  });

  it("does not carry annotations past the next user boundary", () => {
    const turnId = TurnId.make("turn-2");
    const context = deriveResponseAnnotationTurnContext([
      message("user-1", "user", null, [annotation]),
      message("user-2", "user", null),
      message("assistant-2", "assistant", turnId),
    ]);

    expect(context.annotationsByTurnId.get(turnId)).toEqual([]);
    expect(context.userMessageIdByTurnId.get(turnId)).toBe("user-2");
    expect(context.annotationsById.get(annotation.id)).toEqual(annotation);
  });

  it("leaves historical unkeyed assistant messages unresolved", () => {
    const context = deriveResponseAnnotationTurnContext([
      message("user-1", "user", null, [annotation]),
      message("assistant-1", "assistant", null),
    ]);
    expect(context.annotationsByTurnId.size).toBe(0);
  });
});

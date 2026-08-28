import { MessageId, ResponseAnnotationId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  deriveResponseAnnotationTurnContext,
  prepareResponseAnnotationMarkdown,
  responseAnnotationHref,
  responseAnnotationIndexFromHref,
  responseAnnotationReferenceFromHref,
} from "./responseAnnotations";

const timestamp = "2026-08-28T00:00:00.000Z";
const annotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: MessageId.make("assistant-source-1"),
  selectedText: "selected text",
  sourceRange: { start: 0, end: 13, prefix: "", suffix: "" },
  comment: "Check this",
};

function message(
  id: string,
  role: "user" | "assistant",
  turnId: TurnId | null,
  responseAnnotations?: ReadonlyArray<typeof annotation>,
): ThreadFeedEntry {
  return {
    type: "message",
    id,
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

describe("mobile response annotations", () => {
  it("binds a user message's annotations to the following turn", () => {
    const turnId = TurnId.make("turn-1");
    const activity: ThreadFeedEntry = {
      type: "activity-group",
      id: "activity-1",
      createdAt: timestamp,
      turnId,
      activities: [],
    };
    const context = deriveResponseAnnotationTurnContext([
      message("user-1", "user", null, [annotation]),
      activity,
      message("assistant-1", "assistant", turnId),
    ]);

    expect(context.annotationsByTurnId.get(turnId)).toEqual([annotation]);
    expect(context.userMessageIdByTurnId.get(turnId)).toBe("user-1");
  });

  it("does not carry annotations across a newer user boundary", () => {
    const turnId = TurnId.make("turn-2");
    const context = deriveResponseAnnotationTurnContext([
      message("user-1", "user", null, [annotation]),
      message("user-2", "user", null),
      message("assistant-2", "assistant", turnId),
    ]);

    expect(context.annotationsByTurnId.get(turnId)).toEqual([]);
    expect(context.userMessageIdByTurnId.get(turnId)).toBe("user-2");
  });

  it("renders valid directives as links and out-of-range ones as plain labels", () => {
    const markdown = 'Before :codex-annotation{index="1"} and :codex-annotation{index="2"}.';
    expect(prepareResponseAnnotationMarkdown(markdown, [annotation])).toBe(
      `Before [Annotation 1](${responseAnnotationHref(1, annotation.id)}) and Annotation 2.`,
    );
    expect(prepareResponseAnnotationMarkdown(':codex-annotation{index="1"}', [])).toBe(
      "Annotation 1",
    );
  });

  it("keeps malformed directives and code examples literal", () => {
    const markdown = [
      '`:codex-annotation{index="1"}`',
      ":codex-annotation{index=2}",
      '```\n:codex-annotation{index="1"}\n```',
    ].join("\n");
    expect(prepareResponseAnnotationMarkdown(markdown, [annotation])).toBe(markdown);
  });

  it("round-trips internal link indexes", () => {
    const href = responseAnnotationHref(3, annotation.id);
    expect(responseAnnotationIndexFromHref(href)).toBe(3);
    expect(responseAnnotationReferenceFromHref(href)).toEqual({
      index: 3,
      annotationId: annotation.id,
    });
    expect(responseAnnotationIndexFromHref("t3://response-annotation/0")).toBeNull();
    expect(responseAnnotationIndexFromHref("t3://response-annotation/not-a-number")).toBeNull();
  });
});

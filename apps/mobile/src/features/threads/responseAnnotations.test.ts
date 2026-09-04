import { MessageId, ResponseAnnotationId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  prepareResponseAnnotationMarkdown,
  responseAnnotationHref,
  responseAnnotationIndexFromHref,
  responseAnnotationReferenceFromHref,
} from "./responseAnnotations";

const annotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: MessageId.make("assistant-source-1"),
  selectedText: "selected text",
  sourceRange: { start: 0, end: 13, prefix: "", suffix: "" },
  comment: "Check this",
};

describe("mobile response annotations", () => {
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

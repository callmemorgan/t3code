import { MessageId, ResponseAnnotationId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatResponseAnnotationDirective,
  parseResponseAnnotationDirective,
  splitResponseAnnotationDirectives,
} from "@t3tools/shared/responseAnnotations";

import {
  normalizeResponseAnnotations,
  remarkCodexResponseAnnotations,
  resolveCodexResponseAnnotation,
} from "./responseAnnotations";

const annotation = {
  id: ResponseAnnotationId.make("response-annotation-1"),
  sourceMessageId: MessageId.make("assistant-message-1"),
  selectedText: "selected",
  sourceRange: { start: 0, end: 8, prefix: "", suffix: "" },
  comment: "Fix this",
};

describe("Codex response annotation directives", () => {
  it("accepts one-based native directives and rejects malformed syntax", () => {
    expect(parseResponseAnnotationDirective(':codex-annotation{index="2"}')).toEqual({
      rawIndex: "2",
      index: 2,
    });
    expect(parseResponseAnnotationDirective(':codex-annotation{index="0"}')).toEqual({
      rawIndex: "0",
      index: 0,
    });
    expect(parseResponseAnnotationDirective(":codex-annotation{index=2}")).toBeNull();
    expect(parseResponseAnnotationDirective(':codex-annotation{index="two"}')).toBeNull();
    expect(formatResponseAnnotationDirective(2)).toBe(':codex-annotation{index="2"}');
    expect(() => formatResponseAnnotationDirective(0)).toThrow(RangeError);
  });

  it("resolves only an in-range one-based index", () => {
    const directive = parseResponseAnnotationDirective(':codex-annotation{index="1"}')!;
    expect(resolveCodexResponseAnnotation(directive, [annotation])).toBe(annotation);
    expect(
      resolveCodexResponseAnnotation(
        parseResponseAnnotationDirective(':codex-annotation{index="3"}')!,
        [annotation],
      ),
    ).toBeNull();
    expect(
      resolveCodexResponseAnnotation(
        parseResponseAnnotationDirective(':codex-annotation{index="0"}')!,
        [annotation],
      ),
    ).toBeNull();
  });

  it("splits valid directives while retaining surrounding prose", () => {
    expect(splitResponseAnnotationDirectives('a :codex-annotation{index="1"} b')).toEqual([
      { kind: "text", value: "a " },
      {
        kind: "directive",
        directive: { rawIndex: "1", index: 1 },
      },
      { kind: "text", value: " b" },
    ]);
    expect(splitResponseAnnotationDirectives(':codex-annotation{index="x"}')).toEqual([
      { kind: "text", value: ':codex-annotation{index="x"}' },
    ]);
  });

  it("rewrites every prose directive without entering existing links", () => {
    const linkedDirective = { type: "text", value: ':codex-annotation{index="9"}' };
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: 'first :codex-annotation{index="1"} ' },
            {
              type: "emphasis",
              children: [{ type: "text", value: ':codex-annotation{index="2"}' }],
            },
            {
              type: "link",
              url: "https://example.com",
              children: [linkedDirective],
            },
            { type: "text", value: ' last :codex-annotation{index="3"}' },
          ],
        },
      ],
    };

    remarkCodexResponseAnnotations()(tree);

    expect(JSON.stringify(tree)).toContain("t3-codex-response-annotation-1");
    expect(JSON.stringify(tree)).toContain("t3-codex-response-annotation-2");
    expect(JSON.stringify(tree)).toContain("t3-codex-response-annotation-3");
    expect(linkedDirective.value).toBe(':codex-annotation{index="9"}');
  });
});

describe("normalizeResponseAnnotations", () => {
  it("drops malformed entries, de-duplicates IDs, and preserves array order", () => {
    expect(
      normalizeResponseAnnotations([
        annotation,
        { ...annotation, selectedText: "duplicate" },
        { ...annotation, id: ResponseAnnotationId.make("response-annotation-2") },
        { ...annotation, selectedText: "" },
        { ...annotation, sourceRange: { ...annotation.sourceRange, end: 7 } },
      ]),
    ).toEqual([
      annotation,
      { ...annotation, id: ResponseAnnotationId.make("response-annotation-2") },
    ]);
  });

  it("caps persisted annotations at the contract limit", () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      ...annotation,
      id: ResponseAnnotationId.make(`response-annotation-${index}`),
    }));
    expect(normalizeResponseAnnotations(many)).toHaveLength(20);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  formatCodexAnnotationDirective,
  formatResponseAnnotationDirective,
  formatResponseAnnotationPrompt,
  parseResponseAnnotationDirective,
  replaceResponseAnnotationDirectives,
  splitResponseAnnotationDirectives,
} from "./responseAnnotations.ts";

const replace = (markdown: string) =>
  replaceResponseAnnotationDirectives(
    markdown,
    ({ index }) => `[Annotation ${index}](t3:${index})`,
  );

describe("response annotation directives", () => {
  it("formats one-based native directives", () => {
    expect(formatResponseAnnotationDirective(12)).toBe(':codex-annotation{index="12"}');
    expect(() => formatResponseAnnotationDirective(0)).toThrow(RangeError);
    expect(() => formatResponseAnnotationDirective(1.5)).toThrow(RangeError);
  });

  it("replaces valid directives without changing surrounding prose", () => {
    expect(replace('Before :codex-annotation{index="2"} after')).toBe(
      "Before [Annotation 2](t3:2) after",
    );
  });

  it("parses syntax separately from one-based index resolution", () => {
    expect(parseResponseAnnotationDirective(':codex-annotation{index="0"}')).toEqual({
      rawIndex: "0",
      index: 0,
    });
    expect(splitResponseAnnotationDirectives('a :codex-annotation{index="2"} b')).toEqual([
      { kind: "text", value: "a " },
      { kind: "directive", directive: { rawIndex: "2", index: 2 } },
      { kind: "text", value: " b" },
    ]);
  });

  it("leaves malformed and escaped directives literal", () => {
    expect(replace(String.raw`\:codex-annotation{index="1"} :codex-annotation{index=2}`)).toBe(
      String.raw`\:codex-annotation{index="1"} :codex-annotation{index=2}`,
    );
  });

  it("replaces syntactically valid out-of-range indexes", () => {
    expect(replace(':codex-annotation{index="0"}')).toBe("[Annotation 0](t3:0)");
  });

  it("does not replace directives inside inline code", () => {
    expect(replace('`:codex-annotation{index="1"}` :codex-annotation{index="2"}')).toBe(
      '`:codex-annotation{index="1"}` [Annotation 2](t3:2)',
    );
    expect(replace('``code ` :codex-annotation{index="1"}`` :codex-annotation{index="2"}')).toBe(
      '``code ` :codex-annotation{index="1"}`` [Annotation 2](t3:2)',
    );
  });

  it("matches complete backtick runs and ignores escaped backticks", () => {
    expect(
      replace('``code ``` still :codex-annotation{index="1"}`` :codex-annotation{index="2"}'),
    ).toBe('``code ``` still :codex-annotation{index="1"}`` [Annotation 2](t3:2)');
    expect(replace(String.raw`\` before :codex-annotation{index="1"} \` after`)).toBe(
      String.raw`\` before [Annotation 1](t3:1) \` after`,
    );
  });

  it("does not replace directives inside backtick or tilde fences", () => {
    const markdown = [
      "```text",
      ':codex-annotation{index="1"}',
      "```",
      "~~~",
      ':codex-annotation{index="2"}',
      "~~~",
      ':codex-annotation{index="3"}',
    ].join("\n");
    expect(replace(markdown)).toBe(
      markdown.replace(':codex-annotation{index="3"}', "[Annotation 3](t3:3)"),
    );
  });
});

describe("response annotation provider formatting", () => {
  it("formats the native Codex directive with a one-based index", () => {
    expect(formatCodexAnnotationDirective(3)).toBe(':codex-annotation{index="3"}');
  });

  it("leaves ordinary requests unchanged when there are no annotations", () => {
    expect(formatResponseAnnotationPrompt("  inspect this  ", undefined)).toBe("  inspect this  ");
    expect(formatResponseAnnotationPrompt("inspect this", [])).toBe("inspect this");
  });

  it("serializes only selected text and non-empty comments", () => {
    const output = formatResponseAnnotationPrompt("Compare both", [
      {
        selectedText: 'A "quoted" passage',
        comment: "Focus on this",
      },
      {
        selectedText: "A second passage",
        comment: "",
      },
    ]);

    expect(output).toBe(`# Response annotations:
Each item contains text selected from an earlier response and may include a user comment.
Treat items as Annotation 1, Annotation 2, and so on in array order.
Use every selection as context and address every comment.
For every annotation you address, include its inline directive
\`:codex-annotation{index="N"}\`, where N is its one-based array position.
Do not use unstructured annotation labels.
<response-annotations>
[
  {
    "text": "A \\"quoted\\" passage",
    "annotation": "Focus on this"
  },
  {
    "text": "A second passage"
  }
]
</response-annotations>

## My request:
Compare both`);
  });

  it("keeps an annotation-only prompt non-empty", () => {
    const output = formatResponseAnnotationPrompt(undefined, [
      { selectedText: "A selected passage", comment: "" },
    ]);

    expect(output).toContain("<response-annotations>");
    expect(output).toContain('"text": "A selected passage"');
    expect(output).toContain("## My request:");
    expect(output?.length).toBeGreaterThan(0);
  });
});

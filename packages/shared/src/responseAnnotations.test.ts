import { describe, expect, it } from "vite-plus/test";

import {
  formatResponseAnnotationDirective,
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

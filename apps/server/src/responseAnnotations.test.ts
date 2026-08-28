import { describe, expect, it } from "vite-plus/test";

import {
  formatCodexAnnotationDirective,
  formatResponseAnnotationPrompt,
} from "./responseAnnotations.ts";

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

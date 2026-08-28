import { MessageId, ResponseAnnotationId, type ResponseAnnotation } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { ResponseAnnotationSummary } from "./ResponseAnnotationSummary";

vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverPopup: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render }: { render: ReactNode }) => render,
}));

const annotation: ResponseAnnotation = {
  id: ResponseAnnotationId.make("annotation-1"),
  sourceMessageId: MessageId.make("message-1"),
  selectedText: "The selected assistant passage",
  sourceRange: { start: 4, end: 34, prefix: "", suffix: "" },
  comment: "Check this claim",
};

describe("ResponseAnnotationSummary", () => {
  it("shows numbered source text and comments", () => {
    const markup = renderToStaticMarkup(
      <ResponseAnnotationSummary annotations={[annotation]} onJump={vi.fn()} />,
    );
    expect(markup).toContain("1 annotation");
    expect(markup).toContain("Annotation 1");
    expect(markup).toContain("The selected assistant passage");
    expect(markup).toContain("Check this claim");
  });

  it("only offers deletion for editable drafts", () => {
    const readonlyMarkup = renderToStaticMarkup(
      <ResponseAnnotationSummary annotations={[annotation]} onJump={vi.fn()} />,
    );
    const editableMarkup = renderToStaticMarkup(
      <ResponseAnnotationSummary
        annotations={[annotation]}
        editable
        onJump={vi.fn()}
        onRemove={vi.fn()}
      />,
    );
    expect(readonlyMarkup).not.toContain("Delete Annotation 1");
    expect(editableMarkup).toContain('aria-label="Delete Annotation 1"');
  });

  it("keeps the numbered jump and delete entries in draft order", () => {
    const second = {
      ...annotation,
      id: ResponseAnnotationId.make("annotation-2"),
      selectedText: "A second selected passage",
      comment: "Follow up here",
    } satisfies ResponseAnnotation;
    const markup = renderToStaticMarkup(
      <ResponseAnnotationSummary
        annotations={[annotation, second]}
        editable
        onJump={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(markup).toContain("2 annotations");
    expect(markup).toContain('aria-label="Go to Annotation 1"');
    expect(markup).toContain('aria-label="Go to Annotation 2"');
    expect(markup).toContain('aria-label="Delete Annotation 1"');
    expect(markup).toContain('aria-label="Delete Annotation 2"');
    expect(markup).toContain("A second selected passage");
    expect(markup).toContain("Follow up here");
  });
});

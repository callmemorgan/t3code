import { MessageId, ResponseAnnotationId, type ResponseAnnotation } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import {
  canCreateResponseAnnotation,
  deriveResponseAnnotationNumbers,
  isResponseAnnotationSelectionContained,
  responseAnnotationActionPosition,
  responseAnnotationEditorPresentation,
  responseAnnotationEditorPosition,
  responseAnnotationMarkerPosition,
  responseAnnotationTooltipContent,
  ResponseAnnotationSourceMarkers,
  ResponseAnnotationSourceRoot,
  ResponseAnnotationTimelineController,
} from "./ResponseAnnotationController";

const sourceMessageId = MessageId.make("assistant-source");

function annotation(id: string, selectedText: string): ResponseAnnotation {
  return {
    id: ResponseAnnotationId.make(id),
    sourceMessageId,
    selectedText,
    sourceRange: { start: 0, end: selectedText.length, prefix: "", suffix: "" },
    comment: "",
  };
}

describe("response annotation timeline controller", () => {
  it("rejects creation at the bounded draft limit", () => {
    expect(canCreateResponseAnnotation(19)).toBe(true);
    expect(canCreateResponseAnnotation(20)).toBe(false);
    expect(canCreateResponseAnnotation(-1)).toBe(false);
  });

  it("numbers draft markers by array order after deletion", () => {
    const first = annotation("first", "first");
    const second = annotation("second", "second");
    const third = annotation("third", "third");
    const numbers = deriveResponseAnnotationNumbers([first, third]);

    expect(numbers.get(first.id)).toBe(1);
    expect(numbers.get(second.id)).toBeUndefined();
    expect(numbers.get(third.id)).toBe(2);
  });

  it("rejects streaming and cross-source selections", () => {
    const markdown = {
      contains: (node: unknown) => node === markdown || node === textNode,
    };
    const source = {
      dataset: {
        responseAnnotationStreaming: "false",
        responseAnnotationSelectable: "true",
      },
      querySelector: () => markdown,
    };
    const otherSource = {
      dataset: {
        responseAnnotationStreaming: "false",
        responseAnnotationSelectable: "true",
      },
      querySelector: () => markdown,
    };
    const textParent = { closest: () => source };
    const otherTextParent = { closest: () => otherSource };
    const textNode = { nodeType: 3, parentElement: textParent };
    const otherTextNode = { nodeType: 3, parentElement: otherTextParent };
    const timelineRoot = { contains: () => true };
    const range = { commonAncestorContainer: markdown };
    const makeSelection = (focusNode: unknown) =>
      ({
        isCollapsed: false,
        rangeCount: 1,
        anchorNode: textNode,
        focusNode,
        getRangeAt: () => range,
      }) as unknown as Selection;

    expect(
      isResponseAnnotationSelectionContained(makeSelection(textNode), timelineRoot as never),
    ).not.toBeNull();
    expect(
      isResponseAnnotationSelectionContained(makeSelection(otherTextNode), timelineRoot as never),
    ).toBeNull();
    source.dataset.responseAnnotationStreaming = "true";
    expect(
      isResponseAnnotationSelectionContained(makeSelection(textNode), timelineRoot as never),
    ).toBeNull();
  });

  it("keeps the selection action and editor inside the viewport", () => {
    const action = responseAnnotationActionPosition(
      { top: 4, left: 980, width: 30, height: 20 },
      { width: 1024, height: 768 },
    );
    const editor = responseAnnotationEditorPosition(
      { top: 700, left: 980, width: 30, height: 20 },
      { width: 1024, height: 768 },
    );

    expect(action.left).toBeLessThanOrEqual(966);
    expect(action.top).toBeGreaterThanOrEqual(12);
    expect(editor.left + editor.width).toBeLessThanOrEqual(1008);
    expect(editor.top + editor.height).toBeLessThanOrEqual(752);
    expect(editor.top).toBeGreaterThanOrEqual(16);
    expect(editor.maxHeight).toBeLessThanOrEqual(736);
  });

  it("keeps the editor footer available in a short viewport", () => {
    const editor = responseAnnotationEditorPosition(
      { top: 160, left: 100, width: 30, height: 20 },
      { width: 320, height: 180 },
    );

    expect(editor.height).toBe(148);
    expect(editor.top).toBe(16);
    expect(editor.top + editor.height).toBeLessThanOrEqual(164);
  });

  it("keeps sent annotation panels read-only", () => {
    expect(responseAnnotationEditorPresentation(3, false)).toEqual({
      ariaLabel: "View Annotation 3",
      closeLabel: "Close",
      readOnly: true,
    });
    expect(responseAnnotationEditorPresentation(3, true)).toEqual({
      ariaLabel: "Edit Annotation 3",
      closeLabel: "Cancel",
      readOnly: false,
    });
  });

  it("shows source text and the saved comment in marker tooltips", () => {
    const withComment = {
      ...annotation("commented", "selected assistant passage"),
      comment: "  Explain why this matters.  ",
    };

    expect(responseAnnotationTooltipContent(withComment, 2)).toEqual({
      title: "Annotation 2",
      selectedText: "selected assistant passage",
      comment: "Explain why this matters.",
      description: "selected assistant passage. Explain why this matters.",
    });
    expect(
      responseAnnotationTooltipContent(annotation("without-comment", "selected text"), 1),
    ).toMatchObject({
      title: "Annotation 1",
      selectedText: "selected text",
      comment: null,
    });
  });

  it("anchors a source marker just above the selected text endpoint", () => {
    expect(
      responseAnnotationMarkerPosition(
        { top: 140, left: 360, width: 80, height: 20 },
        { top: 100, left: 200, width: 600, height: 400 },
      ),
    ).toEqual({ left: 244, top: 16 });
  });

  it("keeps the full marker above the selection and inside a clipped source row", () => {
    const placement = responseAnnotationMarkerPosition(
      { top: 134, left: 780, width: 40, height: 20 },
      { top: 100, left: 200, width: 600, height: 30 },
    );

    expect(placement).toEqual({ left: 580, top: 10 });
    expect(placement.left).toBeGreaterThanOrEqual(0);
    expect(placement.left + 20).toBeLessThanOrEqual(600);
    expect(placement.top).toBeGreaterThanOrEqual(0);
    expect(placement.top + 20).toBeLessThanOrEqual(30);
  });

  it("marks completed assistant roots without adding row-local listeners", () => {
    const markup = renderToStaticMarkup(
      <ResponseAnnotationTimelineController supported draftAnnotations={[]}>
        <ResponseAnnotationSourceRoot messageId={sourceMessageId} streaming={false}>
          <div className="chat-markdown">Rendered response</div>
        </ResponseAnnotationSourceRoot>
      </ResponseAnnotationTimelineController>,
    );

    expect(markup).toContain('data-response-annotation-timeline="true"');
    expect(markup).toContain('data-response-annotation-source="true"');
    expect(markup).toContain('data-response-annotation-streaming="false"');
    expect(markup).toContain('data-response-annotation-selectable="true"');
    expect(markup).not.toContain("data-response-annotation-markers");
  });

  it("renders every draft annotation as a visible numbered blue bubble", () => {
    const first = annotation("first", "first");
    const second = annotation("second", "second");
    const markup = renderToStaticMarkup(
      <ResponseAnnotationTimelineController supported draftAnnotations={[first, second]}>
        <ResponseAnnotationSourceRoot messageId={sourceMessageId} streaming={false}>
          <div className="chat-markdown">first second</div>
        </ResponseAnnotationSourceRoot>
      </ResponseAnnotationTimelineController>,
    );

    expect(markup.match(/data-response-annotation-marker="/g)).toHaveLength(2);
    expect(markup).toContain('data-response-annotation-marker-editable="true"');
    expect(markup).toContain('aria-label="Edit Annotation 1"');
    expect(markup).toContain('aria-label="Edit Annotation 2"');
    expect(markup).toContain("pt-6 pr-6");
    expect(markup.match(/bg-blue-500/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps draft bubbles after a comment save and renumbers after deletion", () => {
    const first = annotation("first", "first");
    const third = { ...annotation("third", "third"), comment: "saved comment" };
    const markup = renderToStaticMarkup(
      <ResponseAnnotationTimelineController supported draftAnnotations={[first, third]}>
        <ResponseAnnotationSourceRoot messageId={sourceMessageId} streaming={false}>
          <div className="chat-markdown">first third</div>
        </ResponseAnnotationSourceRoot>
      </ResponseAnnotationTimelineController>,
    );

    expect(markup).toContain('aria-label="Edit Annotation 1"');
    expect(markup).toContain('aria-label="Edit Annotation 2"');
    expect(markup).toContain('data-response-annotation-marker="third"');
  });

  it("exposes marker activation as the existing edit interaction for drafts", () => {
    const draft = annotation("draft", "selected passage");
    const markup = renderToStaticMarkup(
      <ResponseAnnotationTimelineController supported draftAnnotations={[draft]}>
        <ResponseAnnotationSourceMarkers
          markers={[{ annotation: draft, number: 1, editable: true }]}
          sourceMessageId={sourceMessageId}
        />
      </ResponseAnnotationTimelineController>,
    );

    expect(markup).toContain('data-response-annotation-marker-editable="true"');
    expect(markup).toContain('aria-label="Edit Annotation 1"');
  });
});

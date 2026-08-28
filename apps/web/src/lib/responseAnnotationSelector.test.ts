import { describe, expect, it } from "vite-plus/test";

import {
  buildResponseAnnotationSourceRange,
  buildRenderedTextIndex,
  domRangeForResponseAnnotation,
  resolveResponseAnnotationSourceRange,
  responseAnnotationSourceRangeFromDomRange,
} from "./responseAnnotationSelector";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
const DOCUMENT_NODE = 9;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];
  parentNode: FakeElement | FakeDocument | null = null;

  constructor(readonly nodeValue: string) {}
}

type FakeChild = FakeElement | FakeText;

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  readonly childNodes: FakeChild[] = [];
  parentNode: FakeElement | FakeDocument | null = null;
  readonly classList = {
    contains: (className: string) => this.classes.has(className),
  };
  readonly ownerDocument: FakeDocument | null;

  constructor(
    readonly tagName: string,
    private readonly classes = new Set<string>(),
    ownerDocument: FakeDocument | null = null,
  ) {
    this.ownerDocument = ownerDocument;
  }

  append(...children: FakeChild[]): this {
    for (const child of children) {
      child.parentNode = this;
      this.childNodes.push(child);
    }
    return this;
  }

  contains(candidate: FakeElement | FakeText): boolean {
    let current: FakeElement | FakeDocument | null = candidate.parentNode;
    while (current) {
      if (current === this) return true;
      current = current.parentNode;
    }
    return candidate === this;
  }

  getAttribute(): string | null {
    return null;
  }
}

class FakeDocument {
  readonly nodeType = DOCUMENT_NODE;
  readonly childNodes: FakeChild[] = [];
  parentNode = null;

  createRange(): FakeRange {
    return new FakeRange();
  }
}

class FakeRange {
  startContainer: FakeElement | FakeText | null = null;
  startOffset = 0;
  endContainer: FakeElement | FakeText | null = null;
  endOffset = 0;

  get collapsed(): boolean {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }

  setStart(container: FakeElement | FakeText, offset: number): void {
    this.startContainer = container;
    this.startOffset = offset;
  }

  setEnd(container: FakeElement | FakeText, offset: number): void {
    this.endContainer = container;
    this.endOffset = offset;
  }
}

function text(value: string): FakeText {
  return new FakeText(value);
}

function element(tagName: string, ...children: FakeChild[]): FakeElement {
  return new FakeElement(tagName).append(...children);
}

function asNode(value: FakeElement | FakeText): Node {
  return value as unknown as Node;
}

function asRange(value: FakeRange): Range {
  return value as unknown as Range;
}

describe("response annotation rendered-text selectors", () => {
  it("keeps inline text together while separating blocks and explicit breaks", () => {
    const first = element(
      "P",
      text("before "),
      element("EM", text("emphasis")),
      element("A", text(" link")),
      text(" after"),
      element("BR"),
      text("line two"),
    );
    const root = element("DIV", first, element("P", text("next block")));

    const index = buildRenderedTextIndex(asNode(root));

    expect(index.text).toBe("before emphasis link after\nline two\nnext block");
    expect(index.segments.map(({ start, end }) => [start, end])).toEqual([
      [0, 7],
      [7, 15],
      [15, 20],
      [20, 26],
      [27, 35],
      [36, 46],
    ]);
  });

  it("keeps consecutive explicit breaks instead of collapsing a blank line", () => {
    const root = element("P", text("first"), element("BR"), element("BR"), text("third"));

    expect(buildRenderedTextIndex(asNode(root)).text).toBe("first\n\nthird");
  });

  it("keeps list, table, and highlighted code separators in the same index", () => {
    const list = element("UL", element("LI", text("first")), element("LI", text("second")));
    const table = element(
      "TABLE",
      element("THEAD", element("TR", element("TH", text("Name")), element("TH", text("Value")))),
      element("TBODY", element("TR", element("TD", text("one")), element("TD", text("two")))),
    );
    const code = element(
      "PRE",
      element(
        "CODE",
        new FakeElement("SPAN", new Set(["line"])).append(text("const one = 1;")),
        new FakeElement("SPAN", new Set(["line"])).append(text("const two = 2;")),
      ),
    );

    expect(buildRenderedTextIndex(asNode(element("DIV", list, table, code))).text).toBe(
      "first\nsecond\nName\tValue\none\ttwo\nconst one = 1;\nconst two = 2;",
    );
  });

  it("preserves blank lines when highlighted code has empty line spans", () => {
    const code = element(
      "PRE",
      element(
        "CODE",
        new FakeElement("SPAN", new Set(["line"])).append(text("first")),
        text("\n"),
        new FakeElement("SPAN", new Set(["line"])),
        text("\n"),
        new FakeElement("SPAN", new Set(["line"])).append(text("third")),
      ),
    );

    expect(buildRenderedTextIndex(asNode(code)).text).toBe("first\n\nthird");
  });

  it("does not index non-selectable chrome between visible blocks", () => {
    const root = element(
      "DIV",
      element("P", text("before")),
      new FakeElement("DIV", new Set(["select-none"])).append(text("language")),
      element("BUTTON", text("Copy code")),
      element("P", text("after")),
    );

    expect(buildRenderedTextIndex(asNode(root)).text).toBe("before\nafter");
  });

  it("keeps UTF-16 offsets on text nodes after inserted separators", () => {
    const emoji = text("😀 ");
    const selected = text("selected");
    const root = element("DIV", element("P", emoji, selected), element("P", text("after")));
    const index = buildRenderedTextIndex(asNode(root));

    expect(index.text).toBe("😀 selected\nafter");
    expect(index.segments.map(({ node, start, end }) => [node.nodeValue, start, end])).toEqual([
      ["😀 ", 0, 3],
      ["selected", 3, 11],
      ["after", 12, 17],
    ]);
  });

  it("maps element-boundary ranges without including an adjacent separator", () => {
    const first = text("first");
    const second = text("second");
    const root = element("DIV", element("P", first), element("P", second));
    const index = buildRenderedTextIndex(asNode(root));

    const firstOnly = new FakeRange();
    firstOnly.setStart(root, 0);
    firstOnly.setEnd(root, 1);
    expect(responseAnnotationSourceRangeFromDomRange(asRange(firstOnly), index)).toMatchObject({
      start: 0,
      end: 5,
    });

    const secondOnly = new FakeRange();
    secondOnly.setStart(root, 1);
    secondOnly.setEnd(root, 2);
    expect(responseAnnotationSourceRangeFromDomRange(asRange(secondOnly), index)).toMatchObject({
      start: 6,
      end: 12,
    });
  });

  it("round-trips a multiline selector to text-node DOM boundaries", () => {
    const first = text("first");
    const second = text("second");
    const document = new FakeDocument();
    const root = new FakeElement("DIV", new Set(), document).append(
      new FakeElement("P", new Set(), document).append(first),
      new FakeElement("P", new Set(), document).append(second),
    );
    const index = buildRenderedTextIndex(asNode(root));
    const selector = buildResponseAnnotationSourceRange(index.text, 0, index.text.length)!;

    const restored = domRangeForResponseAnnotation(
      asNode(root),
      index.text,
      selector,
    ) as unknown as FakeRange;

    expect(restored.startContainer).toBe(first);
    expect(restored.startOffset).toBe(0);
    expect(restored.endContainer).toBe(second);
    expect(restored.endOffset).toBe("second".length);
  });

  it("uses UTF-16 offsets and keeps context bounded", () => {
    const text = "A😀 selected text after";
    const selectedText = "selected text";
    const start = text.indexOf(selectedText);
    const selector = buildResponseAnnotationSourceRange(
      text,
      start,
      start + selectedText.length,
      5,
    );

    expect(start).toBe(4);
    expect(selector).toEqual({
      start: 4,
      end: 17,
      prefix: "A😀 ",
      suffix: " afte",
    });
  });

  it("uses stored offsets when the selected text and context still match", () => {
    const text = "before selected after";
    const selector = buildResponseAnnotationSourceRange(text, 7, 15)!;
    expect(resolveResponseAnnotationSourceRange(text, "selected", selector)).toEqual({
      start: 7,
      end: 15,
    });
  });

  it("does not trust a repeated stored passage when its context changed", () => {
    const original = "old selected target";
    const selector = buildResponseAnnotationSourceRange(original, 4, 12, 4)!;
    const rendered = "new selected target\nold selected target";

    expect(resolveResponseAnnotationSourceRange(rendered, "selected", selector)).toEqual({
      start: rendered.lastIndexOf("selected"),
      end: rendered.lastIndexOf("selected") + "selected".length,
    });
  });

  it("falls back to the matching repeated passage when content moved", () => {
    const original = "first selected old\nsecond selected target";
    const originalStart = original.lastIndexOf("selected");
    const selector = buildResponseAnnotationSourceRange(
      original,
      originalStart,
      originalStart + "selected".length,
    )!;
    const rendered = "intro\nfirst selected old\nsecond selected target";

    expect(resolveResponseAnnotationSourceRange(rendered, "selected", selector)).toEqual({
      start: rendered.lastIndexOf("selected"),
      end: rendered.lastIndexOf("selected") + "selected".length,
    });
  });

  it("uses the stored text when adjacent context changed", () => {
    const selector = buildResponseAnnotationSourceRange("before selected after", 7, 15)!;
    expect(
      resolveResponseAnnotationSourceRange("changed selected context", "selected", selector),
    ).toEqual({
      start: 8,
      end: 16,
    });
  });

  it("searches when the old offset is beyond a shortened response", () => {
    const selector = buildResponseAnnotationSourceRange(
      "long prefix before selected after",
      19,
      27,
    )!;
    expect(resolveResponseAnnotationSourceRange("selected after", "selected", selector)).toEqual({
      start: 0,
      end: 8,
    });
  });

  it("does not resolve when the passage or its context is gone", () => {
    const selector = buildResponseAnnotationSourceRange("before selected after", 7, 15)!;
    expect(
      resolveResponseAnnotationSourceRange("before changed after", "selected", selector),
    ).toBeNull();
  });
});

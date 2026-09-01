const DIRECTIVE_START = ':codex-annotation{index="';
const DIRECTIVE_END = '"}';
const DIRECTIVE_PATTERN = /^:codex-annotation\{index="([0-9]+)"\}$/;
const DIRECTIVE_GLOBAL_PATTERN = /:codex-annotation\{index="([0-9]+)"\}/g;

export interface ResponseAnnotationDirective {
  readonly rawIndex: string;
  readonly index: number | null;
  readonly raw: string;
}

export type ResponseAnnotationDirectivePart =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "directive";
      readonly directive: Omit<ResponseAnnotationDirective, "raw">;
    };

/**
 * Cheap check for whether a message body is worth running the directive
 * renderer over. Callers use this instead of spelling the token themselves, so
 * changing the directive syntax stays a one-file edit.
 */
export function containsResponseAnnotationDirective(value: string): boolean {
  return value.includes(DIRECTIVE_START);
}

export function parseResponseAnnotationDirective(
  value: string,
): Omit<ResponseAnnotationDirective, "raw"> | null {
  const match = DIRECTIVE_PATTERN.exec(value);
  const rawIndex = match?.[1];
  if (!rawIndex) return null;
  const index = Number(rawIndex);
  return {
    rawIndex,
    index: Number.isSafeInteger(index) ? index : null,
  };
}

export function splitResponseAnnotationDirectives(
  value: string,
): ReadonlyArray<ResponseAnnotationDirectivePart> {
  DIRECTIVE_GLOBAL_PATTERN.lastIndex = 0;
  const parts: ResponseAnnotationDirectivePart[] = [];
  let textStart = 0;
  for (const match of value.matchAll(DIRECTIVE_GLOBAL_PATTERN)) {
    const matchStart = match.index ?? textStart;
    if (matchStart > textStart) {
      parts.push({ kind: "text", value: value.slice(textStart, matchStart) });
    }
    const rawIndex = match[1];
    if (rawIndex) {
      const index = Number(rawIndex);
      parts.push({
        kind: "directive",
        directive: {
          rawIndex,
          index: Number.isSafeInteger(index) ? index : null,
        },
      });
    }
    textStart = matchStart + match[0].length;
  }
  if (textStart < value.length) {
    parts.push({ kind: "text", value: value.slice(textStart) });
  }
  return parts.length > 0 ? parts : [{ kind: "text", value }];
}

function backtickRunLength(markdown: string, offset: number): number {
  let end = offset;
  while (markdown[end] === "`") end += 1;
  return end - offset;
}

function closingBacktickRunOffset(
  markdown: string,
  offset: number,
  expectedLength: number,
): number {
  let cursor = offset;
  while (cursor < markdown.length) {
    const candidate = markdown.indexOf("`", cursor);
    if (candidate === -1) return -1;
    const candidateLength = backtickRunLength(markdown, candidate);
    if (!isEscaped(markdown, candidate) && candidateLength === expectedLength) {
      return candidate;
    }
    cursor = candidate + candidateLength;
  }
  return -1;
}

function lineEnd(markdown: string, offset: number): number {
  const newline = markdown.indexOf("\n", offset);
  return newline === -1 ? markdown.length : newline + 1;
}

function fenceAtLineStart(
  markdown: string,
  offset: number,
): { readonly character: "`" | "~"; readonly length: number } | null {
  let cursor = offset;
  let spaces = 0;
  while (spaces < 3 && markdown[cursor] === " ") {
    cursor += 1;
    spaces += 1;
  }
  const character = markdown[cursor];
  if (character !== "`" && character !== "~") return null;
  let end = cursor;
  while (markdown[end] === character) end += 1;
  const length = end - cursor;
  return length >= 3 ? { character, length } : null;
}

function isClosingFence(
  markdown: string,
  offset: number,
  fence: { readonly character: "`" | "~"; readonly length: number },
): boolean {
  const candidate = fenceAtLineStart(markdown, offset);
  if (!candidate || candidate.character !== fence.character || candidate.length < fence.length) {
    return false;
  }
  let cursor = offset;
  while (cursor < markdown.length && markdown[cursor] === " ") cursor += 1;
  cursor += candidate.length;
  const end = lineEnd(markdown, cursor);
  return markdown.slice(cursor, end).trim().length === 0;
}

function directiveAt(markdown: string, offset: number): ResponseAnnotationDirective | null {
  if (!markdown.startsWith(DIRECTIVE_START, offset)) return null;
  let cursor = offset + DIRECTIVE_START.length;
  const digitsStart = cursor;
  while (
    cursor < markdown.length &&
    markdown.charCodeAt(cursor) >= 48 &&
    markdown.charCodeAt(cursor) <= 57
  ) {
    cursor += 1;
  }
  if (cursor === digitsStart || !markdown.startsWith(DIRECTIVE_END, cursor)) return null;
  const rawIndex = markdown.slice(digitsStart, cursor);
  const parsedIndex = Number(rawIndex);
  const index = Number.isSafeInteger(parsedIndex) ? parsedIndex : null;
  const end = cursor + DIRECTIVE_END.length;
  return { rawIndex, index, raw: markdown.slice(offset, end) };
}

function isEscaped(markdown: string, offset: number): boolean {
  let backslashes = 0;
  for (let cursor = offset - 1; cursor >= 0 && markdown[cursor] === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

/**
 * Replaces Codex response-annotation directives in Markdown prose. Inline code
 * and fenced code are copied byte-for-byte so examples remain examples.
 */
export function replaceResponseAnnotationDirectives(
  markdown: string,
  replace: (directive: ResponseAnnotationDirective) => string,
): string {
  let output = "";
  let cursor = 0;
  let lineStart = true;
  let fence: { readonly character: "`" | "~"; readonly length: number } | null = null;

  while (cursor < markdown.length) {
    if (lineStart) {
      if (fence) {
        const closing = isClosingFence(markdown, cursor, fence);
        const end = lineEnd(markdown, cursor);
        output += markdown.slice(cursor, end);
        cursor = end;
        lineStart = true;
        if (closing) fence = null;
        continue;
      }
      const opening = fenceAtLineStart(markdown, cursor);
      if (opening) {
        fence = opening;
        const end = lineEnd(markdown, cursor);
        output += markdown.slice(cursor, end);
        cursor = end;
        lineStart = true;
        continue;
      }
    }

    const character = markdown[cursor]!;
    if (character === "`" && !isEscaped(markdown, cursor)) {
      const runLength = backtickRunLength(markdown, cursor);
      const close = closingBacktickRunOffset(markdown, cursor + runLength, runLength);
      if (close !== -1) {
        const end = close + runLength;
        output += markdown.slice(cursor, end);
        lineStart = markdown[end - 1] === "\n";
        cursor = end;
        continue;
      }
    }

    if (character === ":" && !isEscaped(markdown, cursor)) {
      const directive = directiveAt(markdown, cursor);
      if (directive) {
        output += replace(directive);
        cursor += directive.raw.length;
        lineStart = false;
        continue;
      }
    }

    output += character;
    cursor += 1;
    lineStart = character === "\n";
  }

  return output;
}

export function formatResponseAnnotationDirective(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1) {
    throw new RangeError("Response annotation indexes are one-based positive integers.");
  }
  return `${DIRECTIVE_START}${index}${DIRECTIVE_END}`;
}

/**
 * Formatting for the Codex response-annotation prompt extension.
 *
 * Keep this type independent of the orchestration contracts so the formatter
 * can be reused by clients when they preflight the final provider input.
 */
export interface ResponseAnnotationPromptItem {
  readonly selectedText: string;
  readonly comment: string;
}

const RESPONSE_ANNOTATION_PROMPT_HEADER = `# Response annotations:
Each item contains text selected from an earlier response and may include a user comment.
Treat items as Annotation 1, Annotation 2, and so on in array order.
Use every selection as context and address every comment.
For every annotation you address, include its inline directive
\`:codex-annotation{index="N"}\`, where N is its one-based array position.
Do not use unstructured annotation labels.`;

/**
 * Adds the native annotation context envelope around a user request.
 *
 * An empty annotation list intentionally leaves the request untouched. A
 * non-empty list always produces a non-empty prompt, which permits an
 * annotation-only turn. JSON serialization keeps selected text and comments
 * unambiguous when they contain quotes, newlines, or directive-like text.
 */
export function formatResponseAnnotationPrompt(
  messageText: string | undefined,
  annotations: ReadonlyArray<ResponseAnnotationPromptItem> | undefined,
): string | undefined {
  if (annotations === undefined || annotations.length === 0) {
    return messageText;
  }

  const promptItems = annotations.map((annotation) => ({
    text: annotation.selectedText,
    ...(annotation.comment.trim().length > 0 ? { annotation: annotation.comment } : {}),
  }));

  return [
    RESPONSE_ANNOTATION_PROMPT_HEADER,
    "<response-annotations>",
    JSON.stringify(promptItems, null, 2),
    "</response-annotations>",
    "",
    "## My request:",
    messageText ?? "",
  ].join("\n");
}

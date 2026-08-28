import { formatResponseAnnotationDirective } from "@t3tools/shared/responseAnnotations";

/**
 * Formatting for the Codex response-annotation prompt extension.
 *
 * The provider receives the selected text and optional comment as ordinary
 * prompt text. The stable T3 id and source location stay in persisted message
 * metadata; only the array position is exposed to the provider.
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
 * Builds the provider-facing Codex annotation directive for a one-based item
 * position.
 */
export const formatCodexAnnotationDirective = formatResponseAnnotationDirective;

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

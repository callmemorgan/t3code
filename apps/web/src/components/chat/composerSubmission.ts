import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { formatResponseAnnotationPrompt } from "@t3tools/shared/responseAnnotations";

type ComposerSubmitEvent = { preventDefault: () => void };

/** The annotation fields that reach the provider input the server formats. */
export type ComposerSubmissionResponseAnnotation = {
  readonly selectedText: string;
  readonly comment: string;
};

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  /** Annotations this turn will send; they ride along in the provider input. */
  responseAnnotations?: ReadonlyArray<ComposerSubmissionResponseAnnotation> | undefined;
  submissionTarget: "provider-turn" | "pending-user-input";
};

/**
 * The server wraps annotated turns in a response-annotation envelope before
 * handing the text to the provider, so the envelope counts against the same
 * limit. Measuring it here surfaces the existing over-limit banner while the
 * draft is still editable instead of failing the dispatch.
 */
function providerInputLength(
  text: string,
  responseAnnotations: ReadonlyArray<ComposerSubmissionResponseAnnotation> | undefined,
): number {
  return (formatResponseAnnotationPrompt(text, responseAnnotations) ?? text).length;
}

export function getComposerPromptLengthValidationMessage(
  prompt: string,
  responseAnnotations?: ReadonlyArray<ComposerSubmissionResponseAnnotation> | undefined,
): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    providerInputLength(normalizedPrompt, responseAnnotations),
    providerInputLength(expandAssistantCitationsForProvider(normalizedPrompt), responseAnnotations),
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(
        options.providerInput ?? options.prompt,
        options.responseAnnotations,
      )
    : null;
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}

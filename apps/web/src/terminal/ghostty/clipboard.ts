import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";

/** Application output cannot use the focus-stealing, user-gesture copy fallback. */
export const writeTerminalClipboard = createTerminalClipboardWriter((text) =>
  navigator.clipboard?.writeText(text),
);

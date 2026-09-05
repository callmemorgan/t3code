import { TerminalClipboardParser } from "@t3tools/client-runtime/terminal-clipboard";
import {
  INITIAL_TERMINAL_OUTPUT_CURSOR,
  readTerminalOutputUpdate,
  type TerminalOutputState,
} from "@t3tools/client-runtime/state/terminal";

/** Observe the subscription's live chunks, never a native renderer's history replay. */
export function createTerminalClipboardSession(
  write: (text: string, canWrite: () => boolean) => Promise<void>,
) {
  let active = false;
  let generation = 0;
  let cursor = INITIAL_TERMINAL_OUTPUT_CURSOR;
  const invalidate = () => {
    generation += 1;
    parser.invalidatePendingCopy();
  };
  const parser = new TerminalClipboardParser((text) => {
    const requestedGeneration = generation;
    void write(text, () => active && generation === requestedGeneration);
  });
  return {
    setActive(next: boolean) {
      active = next;
      if (!active) invalidate();
    },
    update(output: TerminalOutputState) {
      const update = readTerminalOutputUpdate(output, cursor);
      cursor = update.cursor;
      if (update.type === "none") return;
      if (update.type === "reset") {
        invalidate();
        parser.reset();
      }
      parser.write(update.data, active && update.type === "append");
    },
  };
}

import { TerminalClipboardParser } from "@t3tools/client-runtime/terminal-clipboard";
import type { TerminalAttachStreamEvent } from "@t3tools/contracts";

/** Observe the subscription's live chunks, never a native renderer's history replay. */
export function createTerminalClipboardSession(
  write: (text: string, canWrite: () => boolean) => Promise<unknown>,
) {
  let active = false;
  let generation = 0;
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
    update(event: TerminalAttachStreamEvent) {
      switch (event.type) {
        case "output":
          parser.write(event.data, active);
          break;
        case "snapshot":
        case "restarted":
          invalidate();
          parser.reset();
          parser.write(event.snapshot.history, false);
          break;
        case "cleared":
        case "closed":
        case "exited":
        case "error":
          invalidate();
          parser.reset();
          break;
      }
    },
  };
}

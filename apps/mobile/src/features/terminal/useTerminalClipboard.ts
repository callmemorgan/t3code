import { useFocusEffect } from "@react-navigation/native";
import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";
import type { EnvironmentId, TerminalAttachInput } from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useCallback } from "react";
import { AppState } from "react-native";
import { terminalEnvironment } from "../../state/terminal";
import { createTerminalClipboardSession } from "./terminalClipboard";

const writeClipboard = createTerminalClipboardWriter((text) => Clipboard.setStringAsync(text));

/** Route focus, not keyboard visibility, owns touch-driven TUI copies on iOS and Android. */
export function useTerminalClipboard(
  environmentId: EnvironmentId | null,
  input: TerminalAttachInput | null,
) {
  useFocusEffect(
    useCallback(() => {
      if (environmentId === null || input === null) return;
      const session = createTerminalClipboardSession(writeClipboard);
      const stop = terminalEnvironment.observeAttach({ environmentId, input }, session.update);
      const activate = () => session.setActive(AppState.currentState === "active");
      activate();
      const change = AppState.addEventListener("change", activate);
      const blur = AppState.addEventListener("blur", () => session.setActive(false));
      const focus = AppState.addEventListener("focus", activate);
      return () => {
        session.setActive(false);
        stop();
        change.remove();
        blur.remove();
        focus.remove();
      };
    }, [environmentId, input]),
  );
}

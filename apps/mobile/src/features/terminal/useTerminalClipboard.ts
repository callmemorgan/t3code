import { useFocusEffect } from "@react-navigation/native";
import { createTerminalClipboardWriter } from "@t3tools/client-runtime/terminal-clipboard";
import type { TerminalOutputState } from "@t3tools/client-runtime/state/terminal";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { AppState } from "react-native";
import { createTerminalClipboardSession } from "./terminalClipboard";

const writeClipboard = createTerminalClipboardWriter((text) => Clipboard.setStringAsync(text));

/** Route focus, not keyboard visibility, owns touch-driven TUI copies on iOS and Android. */
export function useTerminalClipboard(terminalKey: string, output: TerminalOutputState) {
  const current = useRef<{
    terminalKey: string;
    session: ReturnType<typeof createTerminalClipboardSession>;
  } | null>(null);
  const latestOutput = useRef(output);
  useLayoutEffect(() => {
    latestOutput.current = output;
  }, [output]);

  useFocusEffect(
    useCallback(() => {
      const session = createTerminalClipboardSession(writeClipboard);
      current.current = { terminalKey, session };
      const activate = () => {
        session.setActive(false);
        session.update(latestOutput.current);
        session.setActive(AppState.currentState === "active");
      };
      activate();
      const change = AppState.addEventListener("change", activate);
      const blur = AppState.addEventListener("blur", () => session.setActive(false));
      const focus = AppState.addEventListener("focus", activate);
      return () => {
        session.setActive(false);
        current.current = null;
        change.remove();
        blur.remove();
        focus.remove();
      };
    }, [terminalKey]),
  );
  useEffect(() => {
    if (current.current?.terminalKey === terminalKey) current.current.session.update(output);
  }, [output, terminalKey]);
}

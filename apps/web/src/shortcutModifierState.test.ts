import { act, createElement } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  areShortcutModifierStatesEqual,
  shortcutModifierStateAfterKeyboardEvent,
  useShortcutModifierState,
  type ShortcutModifierState,
} from "./shortcutModifierState";

const emptyState = (): ShortcutModifierState => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
});

describe("useShortcutModifierState", () => {
  let renderer: ReactTestRenderer | undefined;

  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it.each(["keyup", "paste", "blur"] as const)(
    "does not render for unchanged modifiers after %s resets the state",
    (reset) => {
      const target = new EventTarget();
      vi.stubGlobal("window", target);
      vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
      const render = vi.fn();
      function Consumer() {
        render(useShortcutModifierState());
        return null;
      }
      act(() => {
        renderer = create(createElement(Consumer));
      });
      const press = (type: "keydown" | "keyup", key: string, shiftKey = false) => {
        act(() => {
          target.dispatchEvent(
            Object.assign(new Event(type), {
              key,
              shiftKey,
              metaKey: false,
              ctrlKey: false,
              altKey: false,
            }),
          );
        });
      };

      press("keydown", "Shift", true);
      expect(render).toHaveBeenLastCalledWith({ ...emptyState(), shiftKey: true });
      if (reset === "keyup") {
        press("keyup", "Shift");
      } else {
        act(() => target.dispatchEvent(new Event(reset)));
      }
      expect(render).toHaveBeenLastCalledWith(emptyState());
      render.mockClear();

      for (const key of "typing") {
        press("keydown", key);
        press("keyup", key);
      }
      act(() => {
        target.dispatchEvent(new Event("paste"));
        target.dispatchEvent(new Event("blur"));
      });
      expect(render).not.toHaveBeenCalled();
      press("keydown", "Shift", true);
      expect(render).toHaveBeenCalledExactlyOnceWith({ ...emptyState(), shiftKey: true });
    },
  );
});

function keyboardEventLike(type: "keydown" | "keyup", init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    type,
    key: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("shortcutModifierState", () => {
  it("compares modifier states by value", () => {
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
      ),
    ).toBe(true);
    expect(
      areShortcutModifierStatesEqual(
        { metaKey: false, ctrlKey: true, altKey: false, shiftKey: true },
        { metaKey: false, ctrlKey: false, altKey: false, shiftKey: true },
      ),
    ).toBe(false);
  });

  it("preserves the current object when modifier values do not change", () => {
    const initialState = emptyState();
    const nextState = shortcutModifierStateAfterKeyboardEvent(
      initialState,
      keyboardEventLike("keyup", { key: "Shift" }),
    );
    expect(nextState).toBe(initialState);
  });

  it("tracks bare modifier keydown and keyup events explicitly", () => {
    let state = emptyState();
    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Meta",
        metaKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keydown", {
        key: "Shift",
        metaKey: true,
        shiftKey: false,
      }),
    );
    expect(state).toEqual({
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Meta",
        metaKey: true,
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: true,
    });

    state = shortcutModifierStateAfterKeyboardEvent(
      state,
      keyboardEventLike("keyup", {
        key: "Shift",
        shiftKey: true,
      }),
    );
    expect(state).toEqual({
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    });
  });

  it("ignores poisoned modifier flags on non-modifier keys", () => {
    // A dictation paste (synthetic ⌘V) can leave the browser reporting
    // metaKey=true on later real key events. Enter to submit must not
    // re-mark ⌘ as held.
    const state = shortcutModifierStateAfterKeyboardEvent(
      emptyState(),
      keyboardEventLike("keydown", { key: "Enter", metaKey: true }),
    );
    expect(state).toEqual(emptyState());
  });

  it("clears a held modifier when a non-modifier key reports it released", () => {
    const heldMeta: ShortcutModifierState = {
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
    };
    const state = shortcutModifierStateAfterKeyboardEvent(
      heldMeta,
      keyboardEventLike("keydown", { key: "a", metaKey: false }),
    );
    expect(state).toEqual(emptyState());
  });
});

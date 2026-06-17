import { describe, expect, it } from "vitest";
import {
  MOBILE_TOUCH_MOVE_SLOP_PX,
  createMobileTerminalGesture,
  markMobileTerminalLongPress,
  shouldDeferMobileTerminalScrollReset,
  shouldOpenMobileTerminalKeyboard,
  updateMobileTerminalGesture,
} from "./mobile-touch";

describe("mobile terminal touch gestures", () => {
  it("opens the keyboard for an unmoved tap", () => {
    const gesture = createMobileTerminalGesture(7, 100, 200);

    expect(shouldOpenMobileTerminalKeyboard(gesture)).toBe(true);
    expect(shouldDeferMobileTerminalScrollReset(gesture)).toBe(false);
  });

  it("keeps tiny drift as a tap", () => {
    const gesture = createMobileTerminalGesture(7, 100, 200);

    const result = updateMobileTerminalGesture(gesture, 104, 205);

    expect(result).toBe("idle");
    expect(gesture.moved).toBe(false);
    expect(gesture.scrolling).toBe(false);
    expect(shouldOpenMobileTerminalKeyboard(gesture)).toBe(true);
  });

  it("classifies vertical pan as terminal scrolling", () => {
    const gesture = createMobileTerminalGesture(7, 100, 200);

    const result = updateMobileTerminalGesture(gesture, 104, 200 + MOBILE_TOUCH_MOVE_SLOP_PX + 8);

    expect(result).toBe("scroll");
    expect(gesture.moved).toBe(true);
    expect(gesture.scrolling).toBe(true);
    expect(shouldOpenMobileTerminalKeyboard(gesture)).toBe(false);
    expect(shouldDeferMobileTerminalScrollReset(gesture)).toBe(true);
  });

  it("classifies horizontal movement as a drag, not vertical terminal scrolling", () => {
    const gesture = createMobileTerminalGesture(7, 100, 200);

    const result = updateMobileTerminalGesture(gesture, 100 + MOBILE_TOUCH_MOVE_SLOP_PX + 8, 204);

    expect(result).toBe("drag");
    expect(gesture.moved).toBe(true);
    expect(gesture.scrolling).toBe(false);
    expect(shouldOpenMobileTerminalKeyboard(gesture)).toBe(false);
    expect(shouldDeferMobileTerminalScrollReset(gesture)).toBe(false);
  });

  it("does not open the keyboard after a long press", () => {
    const gesture = createMobileTerminalGesture(7, 100, 200);

    markMobileTerminalLongPress(gesture);

    expect(gesture.longPress).toBe(true);
    expect(shouldOpenMobileTerminalKeyboard(gesture)).toBe(false);
  });

  it("does not defer scroll reset when there is no gesture", () => {
    expect(shouldDeferMobileTerminalScrollReset(null)).toBe(false);
  });
});

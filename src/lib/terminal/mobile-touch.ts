export const MOBILE_TOUCH_LONG_PRESS_MS = 360;
export const MOBILE_TOUCH_MOVE_SLOP_PX = 12;

export interface MobileTerminalGesture {
  pointerId: number;
  x: number;
  y: number;
  longPress: boolean;
  moved: boolean;
  scrolling: boolean;
}

export type MobileTerminalGestureUpdate = "idle" | "scroll" | "drag";

export function createMobileTerminalGesture(pointerId: number, x: number, y: number): MobileTerminalGesture {
  return {
    pointerId,
    x,
    y,
    longPress: false,
    moved: false,
    scrolling: false,
  };
}

export function markMobileTerminalLongPress(gesture: MobileTerminalGesture): void {
  gesture.longPress = true;
}

export function updateMobileTerminalGesture(
  gesture: MobileTerminalGesture,
  x: number,
  y: number,
  slopPx = MOBILE_TOUCH_MOVE_SLOP_PX,
): MobileTerminalGestureUpdate {
  const dx = x - gesture.x;
  const dy = y - gesture.y;
  if (Math.hypot(dx, dy) <= slopPx) return "idle";

  gesture.moved = true;
  if (Math.abs(dy) >= Math.abs(dx)) {
    gesture.scrolling = true;
    return "scroll";
  }

  return "drag";
}

export function shouldOpenMobileTerminalKeyboard(gesture: MobileTerminalGesture): boolean {
  return !gesture.longPress && !gesture.moved;
}

export function shouldDeferMobileTerminalScrollReset(gesture: MobileTerminalGesture | null): boolean {
  return gesture?.scrolling === true;
}

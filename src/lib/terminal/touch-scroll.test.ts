import { afterEach, describe, it, expect, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { accumulateScroll, resolveScrollTarget, arrowSeq, setupTouchScroll } from "./touch-scroll.ts";

type TouchListener = (event: TouchEvent) => void;

class FakeTouchHost {
  private readonly listeners = new Map<string, Set<TouchListener>>();
  private readonly row = { offsetHeight: 20 };

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") throw new Error("test host only supports function listeners");
    const listeners = this.listeners.get(type) ?? new Set<TouchListener>();
    listeners.add(listener as TouchListener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") return;
    this.listeners.get(type)?.delete(listener as TouchListener);
  }

  querySelector(): { firstElementChild: { offsetHeight: number } } {
    return { firstElementChild: this.row };
  }

  fire(type: string, event: TouchEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function touchEvent(y: number): TouchEvent {
  return {
    touches: [{ clientX: 10, clientY: y }],
    preventDefault() {},
  } as unknown as TouchEvent;
}

function touchEndEvent(): TouchEvent {
  return {
    touches: [],
  } as unknown as TouchEvent;
}

function alternateScreenTerminal(input: string[]): Terminal {
  return {
    modes: {
      mouseTrackingMode: "none",
      applicationCursorKeysMode: false,
    },
    buffer: { active: { type: "alternate" } },
    input(data: string) {
      input.push(data);
    },
  } as unknown as Terminal;
}

describe("setupTouchScroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps pager arrows suppressed when typing focus is lost during the drag", () => {
    const host = new FakeTouchHost();
    const input: string[] = [];
    let typing = true;
    const cleanup = setupTouchScroll(
      host as unknown as HTMLElement,
      alternateScreenTerminal(input),
      () => typing,
    );

    host.fire("touchstart", touchEvent(100));
    typing = false; // the mobile pointer handler blurs the helper at the same drag threshold
    host.fire("touchmove", touchEvent(125));

    expect(input).toEqual([]);
    cleanup();
  });

  it("keeps pager arrows suppressed through the gesture inertia", () => {
    let nextFrame: FrameRequestCallback | undefined;
    let nextHandle = 1;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      nextFrame = callback;
      return nextHandle++;
    });
    vi.stubGlobal("cancelAnimationFrame", () => {});

    const host = new FakeTouchHost();
    const input: string[] = [];
    let typing = true;
    const cleanup = setupTouchScroll(
      host as unknown as HTMLElement,
      alternateScreenTerminal(input),
      () => typing,
    );

    host.fire("touchstart", touchEvent(100));
    typing = false;
    host.fire("touchmove", touchEvent(125));
    host.fire("touchend", touchEndEvent());
    const inertiaFrame = nextFrame;
    if (!inertiaFrame) throw new Error("expected the drag to schedule an inertia frame");
    inertiaFrame(performance.now() + 16);

    expect(input).toEqual([]);
    cleanup();
  });

  it("samples arrow suppression again for the next touch gesture", () => {
    const host = new FakeTouchHost();
    const input: string[] = [];
    let typing = true;
    const cleanup = setupTouchScroll(
      host as unknown as HTMLElement,
      alternateScreenTerminal(input),
      () => typing,
    );

    host.fire("touchstart", touchEvent(100));
    typing = false;
    host.fire("touchmove", touchEvent(125));
    host.fire("touchcancel", touchEndEvent());
    host.fire("touchstart", touchEvent(100));
    host.fire("touchmove", touchEvent(125));

    expect(input).toEqual(["\x1b[A"]);
    cleanup();
  });
});

describe("resolveScrollTarget", () => {
  it("routes a plain shell (scrollback, no alt, no mouse) to scrollback", () => {
    expect(resolveScrollTarget(false, false)).toBe("scrollback");
  });

  it("routes a pager (alt-screen, no mouse tracking) to arrow keys", () => {
    expect(resolveScrollTarget(false, true)).toBe("arrows");
  });

  it("routes a mouse-tracking TUI (Claude Code) to synthetic wheel events", () => {
    expect(resolveScrollTarget(true, true)).toBe("wheel");
  });

  it("prefers wheel over scrollback when an app tracks the mouse in the normal buffer", () => {
    // mouse tracking wins regardless of buffer: the app asked for the events.
    expect(resolveScrollTarget(true, false)).toBe("wheel");
  });
});

describe("arrowSeq", () => {
  it("emits CSI arrows in normal cursor-key mode", () => {
    expect(arrowSeq(true, false)).toBe("\x1b[A");
    expect(arrowSeq(false, false)).toBe("\x1b[B");
  });

  it("emits SS3 arrows under DECCKM (application cursor keys)", () => {
    expect(arrowSeq(true, true)).toBe("\x1bOA");
    expect(arrowSeq(false, true)).toBe("\x1bOB");
  });
});

describe("accumulateScroll", () => {
  it("holds sub-row travel as remainder, scrolls nothing yet", () => {
    expect(accumulateScroll(0, 5, 20)).toEqual({ lines: 0, remainder: 5 });
  });

  it("emits one line exactly on a row boundary, no leftover", () => {
    expect(accumulateScroll(0, 20, 20)).toEqual({ lines: 1, remainder: 0 });
  });

  it("emits one line and carries the overshoot", () => {
    expect(accumulateScroll(0, 25, 20)).toEqual({ lines: 1, remainder: 5 });
  });

  it("carries remainder across calls until a row completes", () => {
    // 15px held + 10px move = 25px → 1 line, 5px carried
    expect(accumulateScroll(15, 10, 20)).toEqual({ lines: 1, remainder: 5 });
  });

  it("is symmetric for the opposite direction (finger up)", () => {
    // trunc toward zero keeps remainder sign matching travel → no up/down skew
    expect(accumulateScroll(0, -25, 20)).toEqual({ lines: -1, remainder: -5 });
  });

  it("emits multiple lines on a fast flick", () => {
    expect(accumulateScroll(0, 65, 20)).toEqual({ lines: 3, remainder: 5 });
  });

  it("is a no-op when row height is unknown (0), preserving remainder", () => {
    expect(accumulateScroll(7, 100, 0)).toEqual({ lines: 0, remainder: 7 });
  });
});

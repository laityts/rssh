import { describe, it, expect } from "vitest";
import { accumulateScroll, resolveScrollTarget, arrowSeq } from "./touch-scroll.ts";

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

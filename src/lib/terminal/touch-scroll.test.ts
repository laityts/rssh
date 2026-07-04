import { describe, it, expect } from "vitest";
import { accumulateScroll, cursorKeySeq } from "./touch-scroll.ts";

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

describe("cursorKeySeq", () => {
  it("positive lines (finger down = scroll up) → Up arrows", () => {
    // reveal earlier content; normal (CSI) cursor mode
    expect(cursorKeySeq(3, false, 8)).toBe("\x1b[A\x1b[A\x1b[A");
  });

  it("negative lines → Down arrows", () => {
    expect(cursorKeySeq(-2, false, 8)).toBe("\x1b[B\x1b[B");
  });

  it("uses SS3 (ESC O) prefix in application-cursor-keys mode", () => {
    expect(cursorKeySeq(1, true, 8)).toBe("\x1bOA");
    expect(cursorKeySeq(-1, true, 8)).toBe("\x1bOB");
  });

  it("emits nothing for zero travel", () => {
    expect(cursorKeySeq(0, false, 8)).toBe("");
  });

  it("caps the number of keys per step (fling flood guard)", () => {
    expect(cursorKeySeq(100, false, 3)).toBe("\x1b[A\x1b[A\x1b[A");
  });

  it("emits nothing when the cap is zero or negative", () => {
    expect(cursorKeySeq(5, false, 0)).toBe("");
    expect(cursorKeySeq(5, false, -1)).toBe("");
  });
});

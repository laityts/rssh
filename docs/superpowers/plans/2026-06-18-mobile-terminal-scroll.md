# Mobile Terminal Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore reliable touch scrolling for mobile terminal scrollback and improve terminal scrollbar drag affordance without changing non-terminal surfaces.

**Architecture:** Extract the terminal touch-gesture decision logic into a small pure TypeScript helper so it can be tested independently, then wire that helper into `TerminalPane.svelte`'s existing mobile soft-keyboard controller. Add terminal-scoped CSS for xterm viewport touch scrolling and coarse-pointer scrollbar sizing; keep global `html/body overflow:hidden` unchanged.

**Tech Stack:** Svelte 5, TypeScript, Vite, Vitest, Tauri 2, `@xterm/xterm@6.0.0`.

## Global Constraints

- Scope is limited to terminal scrollback / xterm scrollbar on mobile.
- Preserve short tap behavior: tapping the terminal still focuses the helper textarea and opens the soft keyboard.
- Preserve long press behavior: long press still hides/locks the helper textarea so native copy/paste menus can work.
- Preserve drag/scroll behavior: a touch or pen move beyond the slop threshold must not open the soft keyboard on pointerup.
- Do not change `html, body { overflow: hidden; }`.
- Do not modify AI/SFTP panel resize, StripBar, Settings, Downloads, or other non-terminal scroll containers.
- Do not upgrade, downgrade, or replace `@xterm/xterm`.
- Do not add runtime dependencies.
- If real mobile-device verification is unavailable, report that explicitly and list substitute checks.

---

## File Structure

- Create `src/lib/terminal/mobile-touch.ts`
  - Owns pure gesture classification for mobile terminal touch/pen input.
  - Exposes constants and helpers consumed by `TerminalPane.svelte`.
- Create `src/lib/terminal/mobile-touch.test.ts`
  - Verifies tap, drift, vertical pan, horizontal drag, long press, and null reset-defer behavior.
- Modify `src/lib/components/TerminalPane.svelte`
  - Imports the helper.
  - Uses helper state in `setupMobileSoftKeyboard()`.
  - Defers document scroll reset while a terminal scroll gesture is active.
  - Adds terminal-scoped xterm viewport touch and scrollbar CSS.
- No changes to `src/styles/global.css`
  - The fix is terminal-scoped in `TerminalPane.svelte`, so the global scrollbar and body overflow model remain unchanged.

---

### Task 1: Add tested mobile terminal gesture classifier

**Files:**
- Create: `src/lib/terminal/mobile-touch.ts`
- Create: `src/lib/terminal/mobile-touch.test.ts`

**Interfaces:**
- Consumes: no project-specific runtime code.
- Produces:
  - `MOBILE_TOUCH_LONG_PRESS_MS: 360`
  - `MOBILE_TOUCH_MOVE_SLOP_PX: 12`
  - `type MobileTerminalGesture`
  - `createMobileTerminalGesture(pointerId: number, x: number, y: number): MobileTerminalGesture`
  - `markMobileTerminalLongPress(gesture: MobileTerminalGesture): void`
  - `updateMobileTerminalGesture(gesture: MobileTerminalGesture, x: number, y: number, slopPx?: number): "idle" | "scroll" | "drag"`
  - `shouldOpenMobileTerminalKeyboard(gesture: MobileTerminalGesture): boolean`
  - `shouldDeferMobileTerminalScrollReset(gesture: MobileTerminalGesture | null): boolean`

- [ ] **Step 1: Write the failing test**

Create `src/lib/terminal/mobile-touch.test.ts` with this exact content:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
npm run test -- src/lib/terminal/mobile-touch.test.ts
```

Expected: FAIL because `src/lib/terminal/mobile-touch.ts` does not exist. The important failure text should include a module resolution error for `./mobile-touch`.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/terminal/mobile-touch.ts` with this exact content:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
npm run test -- src/lib/terminal/mobile-touch.test.ts
```

Expected: PASS for all 6 tests in `mobile-touch.test.ts`.

- [ ] **Step 5: Commit**

Run:

```bash
git add src/lib/terminal/mobile-touch.ts src/lib/terminal/mobile-touch.test.ts
git commit -m "test(terminal): 添加移动端触摸手势分类" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

If git identity is not configured, use a one-command local override:

```bash
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "test(terminal): 添加移动端触摸手势分类" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Wire gesture classifier into TerminalPane and improve terminal-scoped touch scrolling

**Files:**
- Modify: `src/lib/components/TerminalPane.svelte:1-28`
- Modify: `src/lib/components/TerminalPane.svelte:869-1080`
- Modify: `src/lib/components/TerminalPane.svelte:1481-1544`

**Interfaces:**
- Consumes from Task 1:
  - `MOBILE_TOUCH_LONG_PRESS_MS`
  - `createMobileTerminalGesture(pointerId, x, y)`
  - `markMobileTerminalLongPress(gesture)`
  - `updateMobileTerminalGesture(gesture, x, y)`
  - `shouldOpenMobileTerminalKeyboard(gesture)`
  - `shouldDeferMobileTerminalScrollReset(gesture)`
  - `type MobileTerminalGesture`
- Produces:
  - `TerminalPane.svelte` keeps short tap keyboard focus.
  - `TerminalPane.svelte` treats vertical touch/pen pan as terminal scroll and defers document scroll reset during that gesture.
  - `.term-wrap.is-mobile :global(.xterm-viewport)` has terminal-scoped mobile scroll semantics.
  - Coarse-pointer media query increases terminal scrollbar width/height and thumb radius only inside `.term-wrap.is-mobile`.

- [ ] **Step 1: Add imports**

Modify the import block at the top of `src/lib/components/TerminalPane.svelte` by adding this import after the existing terminal imports:

```ts
    import {
        MOBILE_TOUCH_LONG_PRESS_MS,
        createMobileTerminalGesture,
        markMobileTerminalLongPress,
        shouldDeferMobileTerminalScrollReset,
        shouldOpenMobileTerminalKeyboard,
        updateMobileTerminalGesture,
        type MobileTerminalGesture,
    } from "../terminal/mobile-touch.ts";
```

- [ ] **Step 2: Replace the gesture object and constants in `setupMobileSoftKeyboard()`**

In `setupMobileSoftKeyboard(helper: HTMLTextAreaElement)`, replace the local `longPressMs`, `moveSlopPx`, and inline gesture type with:

```ts
        let scrollResetRaf = 0;
        let helperPinRaf = 0;
        let gesture: (MobileTerminalGesture & { timer: number | undefined }) | null = null;
```

- [ ] **Step 3: Gate document scroll reset during active terminal scroll gestures**

Replace the current `resetDocumentScroll()` function with:

```ts
        function resetDocumentScroll() {
            if (shouldDeferMobileTerminalScrollReset(gesture)) return;
            if (scrollResetRaf) return;
            scrollResetRaf = requestAnimationFrame(() => {
                scrollResetRaf = 0;
                if (shouldDeferMobileTerminalScrollReset(gesture)) return;
                if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
                document.documentElement.scrollTop = 0;
                document.documentElement.scrollLeft = 0;
                document.body.scrollTop = 0;
                document.body.scrollLeft = 0;
            });
        }
```

- [ ] **Step 4: Replace pointer handlers with helper-backed logic**

Replace `onPointerDown`, `onPointerMove`, `onPointerUp`, and `onPointerCancel` with this exact code:

```ts
        function onPointerDown(ev: PointerEvent) {
            if (!shouldHandleTouch(ev)) return;
            clearGestureTimer();
            gesture = {
                ...createMobileTerminalGesture(ev.pointerId, ev.clientX, ev.clientY),
                timer: undefined,
            };
            gesture.timer = window.setTimeout(() => {
                if (!gesture || gesture.pointerId !== ev.pointerId) return;
                markMobileTerminalLongPress(gesture);
                hideKeyboard();
            }, MOBILE_TOUCH_LONG_PRESS_MS);
        }

        function onPointerMove(ev: PointerEvent) {
            if (!gesture || gesture.pointerId !== ev.pointerId) return;
            const update = updateMobileTerminalGesture(gesture, ev.clientX, ev.clientY);
            if (update === "idle") return;
            clearGestureTimer();
            hideKeyboard();
        }

        function onPointerUp(ev: PointerEvent) {
            if (!gesture || gesture.pointerId !== ev.pointerId) return;
            const shouldOpenKeyboard = shouldOpenMobileTerminalKeyboard(gesture);
            clearGestureTimer();
            gesture = null;
            if (shouldOpenKeyboard) showKeyboard();
            else lockKeyboard();
        }

        function onPointerCancel(ev: PointerEvent) {
            if (!gesture || gesture.pointerId !== ev.pointerId) return;
            clearGestureTimer();
            gesture = null;
            lockKeyboard();
        }
```

- [ ] **Step 5: Add terminal-scoped mobile scroll CSS**

In the `<style>` block, keep the existing `.term-wrap :global(.xterm-viewport)` rule and add the mobile rule immediately after it:

```css
    .term-wrap.is-mobile :global(.xterm-viewport) {
        touch-action: pan-y;
        overscroll-behavior: contain;
        -webkit-overflow-scrolling: touch;
    }
```

Then add this coarse-pointer scrollbar rule after the mobile composition-view rule and before the overlay comments:

```css
    @media (pointer: coarse) {
        .term-wrap.is-mobile :global(.xterm-viewport::-webkit-scrollbar) {
            width: 14px;
        }

        .term-wrap.is-mobile :global(.xterm-viewport::-webkit-scrollbar-thumb) {
            min-height: 44px;
            border: 4px solid transparent;
            border-radius: 999px;
            background: color-mix(in srgb, var(--text-dim) 70%, transparent);
            background-clip: padding-box;
        }

        .term-wrap.is-mobile :global(.xterm-viewport::-webkit-scrollbar-thumb:hover),
        .term-wrap.is-mobile :global(.xterm-viewport::-webkit-scrollbar-thumb:active) {
            background: color-mix(in srgb, var(--text-sub) 85%, transparent);
            background-clip: padding-box;
        }
    }
```

- [ ] **Step 6: Run targeted tests**

Run:

```bash
npm run test -- src/lib/terminal/mobile-touch.test.ts
```

Expected: PASS for all 6 mobile touch tests.

- [ ] **Step 7: Run full test suite**

Run:

```bash
npm run test
```

Expected: PASS for all existing Vitest tests.

- [ ] **Step 8: Run build**

Run:

```bash
npm run build
```

Expected: Vite build succeeds. If it fails due TypeScript/Svelte errors in the changed files, fix the changed code and rerun. If it fails due an unrelated pre-existing issue, record the exact failure in the final report.

- [ ] **Step 9: Commit**

Run:

```bash
git add src/lib/components/TerminalPane.svelte src/lib/terminal/mobile-touch.ts src/lib/terminal/mobile-touch.test.ts
git commit -m "fix(terminal): 改善移动端终端触摸回滚" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

If git identity is not configured, use:

```bash
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -m "fix(terminal): 改善移动端终端触摸回滚" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Manual Verification Checklist

Use this after Task 2 when a mobile runtime or mobile browser emulation is available:

- [ ] Produce long terminal output, for example `seq 1 300`.
- [ ] From the middle of the terminal canvas, swipe vertically; expected: scrollback moves and soft keyboard does not open during the swipe.
- [ ] Tap the terminal once; expected: helper textarea focuses and the soft keyboard opens.
- [ ] Open the keyboard, dismiss it, then swipe terminal scrollback; expected: scrollback still moves.
- [ ] Drag the terminal right scrollbar; expected: thumb is easier to acquire on coarse-pointer devices.
- [ ] Start a swipe from the terminal middle and from the left command-block gutter; expected: normal vertical scrollback is not blocked.

---

## Plan Self-Review

- Spec coverage: Task 1 covers testable gesture classification; Task 2 covers TerminalPane integration, reset deferral, xterm viewport touch CSS, and terminal-scoped scrollbar affordance. Non-goals are explicitly excluded by Global Constraints.
- Completeness scan: every implementation step includes exact files, code, commands, and expected outcomes.
- Type consistency: Task 2 imports exactly the functions and types produced by Task 1. `gesture` is typed as `MobileTerminalGesture & { timer: number | undefined }` so existing timer cleanup remains explicit.

import type { Terminal } from "@xterm/xterm";

/**
 * Mobile touch-scroll for an xterm terminal. xterm 6.0.0 vendors a VS Code
 * touch-gesture service (with inertia!) but never calls addTarget(), so
 * touch-drag is wired to nothing — desktop has the wheel, touch had no scroll
 * path at all. This adds drag-to-scroll plus the fling momentum that every
 * native scroll surface has.
 *
 * Where the scroll GOES depends on what the terminal is running, mirroring
 * exactly what xterm's own wheel handler does for a desktop physical wheel:
 *
 *   - Mouse-tracking apps (Claude Code, vim `:set mouse=a`, tmux, zellij) run
 *     in the alternate screen AND ask to receive mouse events. They have no
 *     xterm scrollback, so scrollLines() is a no-op — the app scrolls its OWN
 *     view when it gets wheel reports. We synthesize WheelEvents on the xterm
 *     element and let xterm encode them (SGR/X10/…, per the app's protocol).
 *   - Alternate-screen apps WITHOUT mouse tracking (less, man, git log's
 *     pager) scroll on arrow keys, so we send cursor-up/down — matching
 *     xterm's own fallback for that case. Those arrows are REAL PTY input, so
 *     the caller can pass `suppressArrowInput` to gate them off while the user
 *     is typing (IME composing / soft keyboard up) — otherwise a scroll gesture
 *     would refill the input line of an app that binds ↑/↓ to history recall.
 *   - Everything else (normal shell, codex) has real scrollback: scrollLines().
 *
 * `accumulateScroll` and `resolveScrollTarget` are the pure, unit-tested core,
 * shared by both the live drag and the inertia frames. `setupTouchScroll` is
 * the DOM glue, kept here so both terminal hosts (TerminalPane, PlaybackScreen)
 * share one implementation.
 */

export type ScrollTarget = "scrollback" | "wheel" | "arrows";

/**
 * Decide where a scroll gesture should go, mirroring xterm's desktop wheel
 * handler. Mouse tracking wins over alt-screen: an app that both switched to
 * the alt buffer and enabled mouse reports (the TUI case) wants the wheel
 * events, not synthetic arrows.
 */
export function resolveScrollTarget(
  mouseTracking: boolean,
  altBuffer: boolean,
): ScrollTarget {
  if (mouseTracking) return "wheel";
  if (altBuffer) return "arrows";
  return "scrollback";
}

/**
 * Cursor-key sequence for one line of pager scroll. DECCKM (application cursor
 * keys) picks SS3 (ESC O x) over CSI (ESC [ x) — the same rule xterm uses when
 * it falls back to arrows on a wheel in a no-scrollback buffer.
 */
export function arrowSeq(up: boolean, appCursorKeys: boolean): string {
  return (appCursorKeys ? "\x1bO" : "\x1b[") + (up ? "A" : "B");
}

/**
 * Convert accumulated travel (px) into whole terminal lines, carrying the
 * sub-line remainder so motion stays 1:1 and never loses precision over a long
 * swipe — or across the drag→fling handoff (both feed the same remainder).
 *
 * trunc (toward zero), not floor: it keeps the remainder's sign matching the
 * travel, so up and down behave symmetrically — no special case per direction.
 */
export function accumulateScroll(
  remainder: number,
  deltaPx: number,
  rowHeight: number,
): { lines: number; remainder: number } {
  if (rowHeight <= 0) return { lines: 0, remainder };
  const total = remainder + deltaPx;
  const lines = Math.trunc(total / rowHeight);
  return { lines, remainder: total - lines * rowHeight };
}

// Tunables (device-feel; adjust on real hardware). Velocity is px/ms.
// Keep TAKEOVER_PX == the soft-keyboard handler's moveSlopPx (12, in TerminalPane)
// AND match its boundary: we claim only when travel EXCEEDS it (the check below uses
// `<=`), exactly when that handler flips to "moved" (hypot > slop). Otherwise a small
// drag could scroll yet still pop the keyboard on release.
const TAKEOVER_PX = 12;   // claim the gesture as a scroll once travel exceeds this
const FLING_MIN_V = 0.12; // release faster than this (~120 px/s) starts a fling
const STOP_V = 0.02;      // fling ends once it decays below this (~20 px/s)
const FRICTION = 0.94;    // per-60fps-frame velocity decay (frame-rate normalized)
const PAUSE_MS = 60;      // finger paused longer than this before release → no fling

/**
 * Wire one-finger vertical drag → scrollback on `host` (the element passed to
 * terminal.open()), with fling momentum on release. Returns a cleanup fn.
 *
 * Takes over only after the finger travels past a threshold, so a stationary
 * tap (focus / soft keyboard) and a stationary long-press (native text
 * selection) still pass through untouched; only a real drag scrolls. A new
 * touch cancels any in-flight fling (grab-to-stop, like native lists).
 * Caller decides when to install it (e.g. mobile only).
 *
 * `suppressArrowInput`, when supplied, is sampled at touchstart and gates OFF
 * the pager arrow-key path (alt-screen, no mouse tracking) for that whole drag
 * and its fling — the gesture then scrolls nothing rather than injecting ↑/↓
 * into the PTY. Wheel and scrollback are never gated: wheel means the app
 * explicitly asked for mouse reports, and scrollback never touches PTY input.
 * Use it to stop a scroll from clobbering the input line while the user is
 * composing / typing.
 */
export function setupTouchScroll(
  host: HTMLElement,
  terminal: Terminal,
  suppressArrowInput?: () => boolean,
): () => void {
  let startY = 0;
  let lastY = 0;
  let lastX = 0;      // clientX of the finger, for synthetic wheel-event coords
  let remainder = 0;   // sub-row px carried across moves AND into the fling
  let rowH = 0;        // px, sampled once per gesture (see measureRowHeight)
  let active = false;  // gesture claimed as a scroll (finger down)
  let ignore = false;  // gesture disqualified (multi-touch) until all fingers lift
  let velocity = 0;    // px/ms, recent-biased; sign = drag direction (dy)
  let lastMoveTime = 0;
  let inertiaRaf = 0;  // rAF handle, 0 = no fling running (invariant I1)
  let suppressArrowsForGesture = false;

  // Row height is constant within a gesture (font can't change mid-drag), so sample
  // it ONCE at takeover, not per frame: reading offsetHeight while xterm is repainting
  // rows forces a synchronous layout reflow on every touchmove/fling frame (layout
  // thrash). Cached in rowH.
  function measureRowHeight(): number {
    const row = host.querySelector(".xterm-rows")?.firstElementChild as HTMLElement | null;
    return row?.offsetHeight ?? 0;
  }

  // Safety cap: one fling/drag frame can't dispatch an unbounded burst of
  // synthetic wheel events or arrow bytes (a runaway velocity would flood the
  // PTY). Real gestures stay well under this.
  const MAX_LINES_PER_CALL = 100;

  // Send one line of app-scroll as a synthetic WheelEvent on xterm's element,
  // reusing xterm's own mouse-protocol encoding (SGR/X10/…). deltaMode=LINE so
  // coreMouseService.consumeWheelEvent returns a whole line (its gate only needs
  // non-zero; xterm then emits one wheel-button report regardless of magnitude).
  // Coords must land inside the screen or getMouseReportCoords rejects the event.
  function dispatchWheelLine(up: boolean) {
    const el = terminal.element;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const clientX = Math.min(Math.max(lastX, rect.left + 1), rect.right - 1);
    const clientY = Math.min(Math.max(lastY, rect.top + 1), rect.bottom - 1);
    el.dispatchEvent(new WheelEvent("wheel", {
      deltaY: up ? -1 : 1,
      deltaMode: WheelEvent.DOM_DELTA_LINE,
      clientX,
      clientY,
      bubbles: true,
      cancelable: true,
    }));
  }

  // Finger down (dy>0) → r.lines>0 → reveal earlier output = scroll up.
  // Route the same intent three ways, mirroring xterm's desktop wheel handler:
  // real scrollback, app wheel reports, or pager arrow keys.
  function scrollByPx(px: number) {
    const r = accumulateScroll(remainder, px, rowH);
    remainder = r.remainder;
    if (r.lines === 0) return;
    const mouseTracking = terminal.modes.mouseTrackingMode !== "none";
    const altBuffer = terminal.buffer.active.type === "alternate";
    const target = resolveScrollTarget(mouseTracking, altBuffer);
    if (target === "scrollback") {
      terminal.scrollLines(-r.lines);
      return;
    }
    const up = r.lines > 0;
    const count = Math.min(Math.abs(r.lines), MAX_LINES_PER_CALL);
    if (target === "wheel") {
      // App enabled mouse tracking → it asked for wheel reports; always safe.
      for (let i = 0; i < count; i++) dispatchWheelLine(up);
    } else {
      // "arrows" is REAL PTY input. For a pager it scrolls; but for any
      // alt-screen app that binds ↑/↓ to history recall or cursor motion it
      // would corrupt the input line — and we can't tell them apart from the
      // terminal state. So when the user is actively typing (IME composing /
      // soft keyboard up), suppress the injection: no scroll beats a garbled
      // input box. Real pagers don't hold an open text field, so nothing lost.
      if (suppressArrowsForGesture) return;
      const seq = arrowSeq(up, terminal.modes.applicationCursorKeysMode);
      terminal.input(seq.repeat(count), true);
    }
  }

  function cancelInertia() {
    if (inertiaRaf) {
      cancelAnimationFrame(inertiaRaf);
      inertiaRaf = 0;
    }
  }

  function inertiaStep(now: number) {
    const dt = Math.max(now - lastMoveTime, 1);
    lastMoveTime = now;
    velocity *= Math.pow(FRICTION, dt / 16.6667); // frame-rate independent decay
    if (Math.abs(velocity) < STOP_V) { inertiaRaf = 0; return; }
    scrollByPx(velocity * dt);
    inertiaRaf = requestAnimationFrame(inertiaStep);
  }

  function onTouchStart(e: TouchEvent) {
    cancelInertia();          // a new touch grabs and stops the glide (I2)
    active = false;
    velocity = 0;
    // Only a clean single-finger start tracks. A finger added mid-gesture (pinch)
    // disqualifies the gesture until ALL fingers lift and a fresh single touch
    // begins — never scroll from stale coordinates.
    ignore = e.touches.length !== 1;
    suppressArrowsForGesture = false;
    if (ignore) return;
    // Snapshot before the mobile pointer handler can blur the helper when this
    // same gesture crosses its move threshold. Re-reading focus during the drag
    // would lose the fact that the user was typing when the gesture began.
    suppressArrowsForGesture = suppressArrowInput?.() ?? false;
    startY = lastY = e.touches[0].clientY;
    lastX = e.touches[0].clientX;
    lastMoveTime = performance.now();
    remainder = 0;
  }

  function onTouchMove(e: TouchEvent) {
    if (ignore) return;
    if (e.touches.length !== 1) {  // a second finger joined → abandon this scroll
      ignore = true;
      active = false;
      velocity = 0;
      return;
    }
    const y = e.touches[0].clientY;
    if (!active) {
      if (Math.abs(y - startY) <= TAKEOVER_PX) return; // dead zone: tap / long-press
      active = true; // claim it; lastY & lastMoveTime stay at the touch start, so THIS
                     // frame scrolls the full travel and times velocity honestly
      rowH = measureRowHeight(); // sample once; reused for this drag + its fling
    }
    // Claimed: block native selection/scroll so it can't fight us.
    e.preventDefault();
    const now = performance.now();
    const dy = y - lastY;
    const dt = Math.max(now - lastMoveTime, 1);
    velocity = velocity * 0.2 + (dy / dt) * 0.8; // EMA, recent-biased for fling
    lastMoveTime = now;
    lastY = y;
    lastX = e.touches[0].clientX;
    scrollByPx(dy);
  }

  function onTouchEnd(e: TouchEvent) {
    if (!active) return;      // wasn't a scroll drag → nothing to fling
    active = false;
    // Other fingers still down (e.g. a 2nd finger that landed off-host, so we never
    // saw its touchstart) → not a clean single-finger release, don't fling.
    if (e.touches.length > 0) return;
    // Paused before lifting, or barely moving → no fling (native behavior).
    if (performance.now() - lastMoveTime > PAUSE_MS) return;
    if (Math.abs(velocity) < FLING_MIN_V) return;
    lastMoveTime = performance.now();
    inertiaRaf = requestAnimationFrame(inertiaStep);
  }

  // Interrupted gesture (system takeover, extra touch): stop, never fling.
  function onTouchCancel() {
    active = false;
    cancelInertia();
  }

  host.addEventListener("touchstart", onTouchStart, { passive: true });
  host.addEventListener("touchmove", onTouchMove, { passive: false });
  host.addEventListener("touchend", onTouchEnd, { passive: true });
  host.addEventListener("touchcancel", onTouchCancel, { passive: true });

  return () => {
    cancelInertia(); // must run before terminal.dispose() — callers order it so (I4)
    host.removeEventListener("touchstart", onTouchStart);
    host.removeEventListener("touchmove", onTouchMove);
    host.removeEventListener("touchend", onTouchEnd);
    host.removeEventListener("touchcancel", onTouchCancel);
  };
}

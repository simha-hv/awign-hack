/**
 * Thumbstick: visible at rest, floating origin in use.
 *
 * Two requirements that pull against each other:
 *
 *  - It has to LOOK like a joystick before anyone touches it. The first version
 *    drew nothing but a faint dashed ring, and only became a stick once you
 *    were already dragging — so the thing you needed to understand only
 *    appeared after you had understood it.
 *  - It has to FEEL like a floating stick. A fixed base gives every grip that
 *    lands slightly off-centre a lurch on the very first frame.
 *
 * So: the base and knob live at a home position and are always drawn. On touch
 * the base slides to wherever the thumb landed and the knob follows it with no
 * transition at all; on release both ease back home.
 *
 * Rendering is synchronous inside the touch handler and never waits for the
 * host to echo anything. The character on the big screen may lag by a round
 * trip; the knob under the thumb must not.
 */

/** Below this deflection the stick reads as centred. */
const DEADZONE = 0.14;
/** Radius, in px, at which deflection reaches 1.0. */
const RANGE = 62;

export class Stick {
  /**
   * -1..1, deadzoned and rescaled. `y` is in SCREEN coordinates: +Y is DOWN.
   * The host maps this to world movement; see game/controls.ts.
   */
  x = 0;
  y = 0;

  /** The touch currently driving the stick, or null. */
  private touchId: number | null = null;
  private originX = 0;
  private originY = 0;

  /** Resting position, recomputed on resize because it depends on the zone. */
  private homeX = 0;
  private homeY = 0;

  constructor(
    private readonly zone: HTMLElement,
    private readonly base: HTMLElement,
    private readonly knob: HTMLElement,
    private readonly label?: HTMLElement,
  ) {
    this.layout();
    addEventListener('resize', this.layout);
    // The zone is laid out by flexbox, so on first paint its rect can still be
    // zero. One more pass after layout settles.
    requestAnimationFrame(this.layout);
  }

  /** Park the stick at its home position. Also the resize handler. */
  private readonly layout = (): void => {
    const rect = this.zone.getBoundingClientRect();
    if (rect.width === 0) return;
    // Left of centre in its half, low enough for a thumb, clear of the buttons.
    this.homeX = rect.left + rect.width * 0.5;
    // High enough to stay clear of the browser's bottom bar and tabs.
    this.homeY = rect.top + rect.height * 0.45;
    if (this.touchId === null) this.park();
  };

  private park(): void {
    this.place(this.base, this.homeX, this.homeY);
    this.place(this.knob, this.homeX, this.homeY);
    if (this.label) this.place(this.label, this.homeX, this.homeY + 88);
  }

  private place(el: HTMLElement, x: number, y: number): void {
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  }

  get active(): boolean {
    return this.touchId !== null;
  }

  owns(identifier: number): boolean {
    return this.touchId === identifier;
  }

  /** Claim a touch that landed inside the stick zone. */
  tryClaim(touch: Touch): boolean {
    if (this.touchId !== null) return false;
    const rect = this.zone.getBoundingClientRect();
    if (
      touch.clientX < rect.left ||
      touch.clientX > rect.right ||
      touch.clientY < rect.top ||
      touch.clientY > rect.bottom
    ) {
      return false;
    }

    this.touchId = touch.identifier;
    this.originX = touch.clientX;
    this.originY = touch.clientY;

    // Kill the easing BEFORE the first move, or the knob eases into the thumb
    // over 180ms and the very first flick of a round is mush.
    this.base.classList.add('dragging');
    this.knob.classList.add('dragging');
    this.place(this.base, this.originX, this.originY);
    // Once used, the label has done its job.
    this.label?.classList.add('used');

    this.move(touch);
    return true;
  }

  move(touch: Touch): void {
    if (this.touchId !== touch.identifier) return;

    let dx = touch.clientX - this.originX;
    let dy = touch.clientY - this.originY;

    // Clamp to the ring, keeping direction.
    const dist = Math.hypot(dx, dy);
    if (dist > RANGE) {
      dx = (dx / dist) * RANGE;
      dy = (dy / dist) * RANGE;
    }

    // Draw immediately — synchronous, no rAF, no network.
    this.place(this.knob, this.originX + dx, this.originY + dy);

    const nx = dx / RANGE;
    const ny = dy / RANGE;
    const mag = Math.min(1, Math.hypot(nx, ny));

    if (mag < DEADZONE) {
      this.x = 0;
      this.y = 0;
      return;
    }

    // Rescale past the deadzone so output ramps from 0, not from DEADZONE —
    // otherwise the character jumps to 14% speed the instant you cross it.
    const scaled = (mag - DEADZONE) / (1 - DEADZONE);
    const inv = scaled / mag;
    this.x = nx * inv;
    this.y = ny * inv;
  }

  release(identifier: number): void {
    if (this.touchId !== identifier) return;
    this.touchId = null;
    this.x = 0;
    this.y = 0;
    // Re-enable the transition first, then move: that is what makes it spring
    // home instead of teleporting.
    this.base.classList.remove('dragging');
    this.knob.classList.remove('dragging');
    this.park();
  }

  /** Force-centre, e.g. when the page is backgrounded mid-drag. */
  reset(): void {
    if (this.touchId !== null) this.release(this.touchId);
  }
}

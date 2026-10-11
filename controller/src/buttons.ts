import { BUTTON_A, BUTTON_B, BUTTON_C, writeCounter } from '@brawl/protocol';

/**
 * The face buttons: A punch, B grab/throw, C jump.
 *
 * Each keeps a 2-bit rolling press counter that increments on press and
 * never on release. The packed u16 is what goes on the wire. The host diffs
 * it, so a tap that starts and ends between two delivered snapshots still
 * registers — which is the entire reason this is not a boolean.
 */
class Button {
  /** The touch holding this button, or null. */
  private touchId: number | null = null;
  /** 0..3, wraps. */
  counter = 0;

  constructor(
    readonly index: number,
    private readonly el: HTMLElement,
  ) {}

  get held(): boolean {
    return this.touchId !== null;
  }

  hitTest(touch: Touch): boolean {
    const rect = this.el.getBoundingClientRect();
    // Circular hit test with a little slop — thumbs are imprecise and a
    // rectangular test on a round button feels wrong at the corners.
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const r = rect.width / 2 + 12;
    return Math.hypot(touch.clientX - cx, touch.clientY - cy) <= r;
  }

  tryClaim(touch: Touch): boolean {
    if (this.touchId !== null || !this.hitTest(touch)) return false;
    this.touchId = touch.identifier;
    this.counter = (this.counter + 1) & 0b11;
    this.el.classList.add('pressed');
    return true;
  }

  owns(identifier: number): boolean {
    return this.touchId === identifier;
  }

  release(identifier: number): void {
    if (this.touchId !== identifier) return;
    this.touchId = null;
    this.el.classList.remove('pressed');
  }

  reset(): void {
    if (this.touchId !== null) this.release(this.touchId);
  }
}

export class Buttons {
  private readonly all: Button[];

  constructor(aEl: HTMLElement, bEl: HTMLElement, cEl: HTMLElement) {
    this.all = [new Button(BUTTON_A, aEl), new Button(BUTTON_B, bEl), new Button(BUTTON_C, cEl)];
  }

  /**
   * Returns true if some button took the touch.
   *
   * First match wins, so overlapping hit slop between adjacent buttons cannot
   * fire two of them from one thumb.
   */
  tryClaim(touch: Touch): boolean {
    for (const b of this.all) if (b.tryClaim(touch)) return true;
    return false;
  }

  owns(identifier: number): boolean {
    return this.all.some((b) => b.owns(identifier));
  }

  release(identifier: number): void {
    for (const b of this.all) b.release(identifier);
  }

  reset(): void {
    for (const b of this.all) b.reset();
  }

  /** Pack every counter into the u16 that goes on the wire. */
  pack(): number {
    let buttons = 0;
    for (const b of this.all) buttons = writeCounter(buttons, b.index, b.counter);
    return buttons;
  }
}

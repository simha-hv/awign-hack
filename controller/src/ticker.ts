import {
  encodeSnapshot,
  SNAPSHOT_BYTES,
  TICK_MS,
  unitToAxis,
  type GamepadTransport,
} from '@brawl/protocol';

import type { Buttons } from './buttons.js';
import type { Stick } from './stick.js';

/**
 * Samples local input state at a fixed 30Hz and sends one snapshot per tick.
 *
 * Deliberately NOT event-driven. A `touchmove` handler that sends on every
 * event produces bursts of 60-120 messages a second on a fast finger and
 * nothing at all on a still one — the worst possible traffic shape for a
 * congested venue wifi, and it makes the host's job harder rather than easier.
 * A fixed cadence of fixed-size snapshots is predictable to buffer, trivial to
 * pace, and drops cleanly.
 */
export class InputTicker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seq = 0;
  /** Reused every tick — no per-frame allocation. */
  private readonly buffer = new Uint8Array(SNAPSHOT_BYTES);

  /** Diagnostics. */
  sent = 0;

  constructor(
    private readonly transport: GamepadTransport,
    private readonly stick: Stick,
    private readonly buttons: Buttons,
  ) {}

  get running(): boolean {
    return this.timer !== null;
  }

  start(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    this.seq = (this.seq + 1) & 0xff;
    encodeSnapshot(
      {
        seq: this.seq,
        axisX: unitToAxis(this.stick.x),
        axisY: unitToAxis(this.stick.y),
        buttons: this.buttons.pack(),
      },
      this.buffer,
    );
    this.transport.sendInput(this.buffer);
    this.sent++;
  }

  /**
   * Send one centred snapshot immediately, preserving the button counters.
   *
   * Used when the page is backgrounded: without it the host keeps the last
   * non-zero axes for its 500ms silence timeout and the character drifts on
   * after the player has left the tab.
   */
  flushNeutral(): void {
    this.seq = (this.seq + 1) & 0xff;
    encodeSnapshot(
      { seq: this.seq, axisX: 0, axisY: 0, buttons: this.buttons.pack() },
      this.buffer,
    );
    this.transport.sendInput(this.buffer);
  }
}

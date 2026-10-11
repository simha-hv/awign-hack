import type {
  DisconnectReason,
  GamepadTransport,
  PeerId,
  TransportStats,
} from '@brawl/protocol';
import { HOST_PEER } from '@brawl/protocol';
import type { WsLink } from '@brawl/protocol/ws-link.js';

/**
 * Controller-side input transport over the relay WebSocket.
 *
 * The entire implementation is `link.sendBinary`. That is the point: when the
 * WebRTC DataChannel version arrives it implements this same interface, and
 * nothing in the stick, button or ticker code changes — they only ever call
 * `sendInput`.
 */
export class ControllerWsTransport implements GamepadTransport {
  private disconnectCb: ((peer: PeerId, reason: DisconnectReason) => void) | null = null;
  private off: (() => void) | null = null;

  constructor(private readonly link: WsLink) {}

  async connect(): Promise<void> {
    this.off = this.link.onClosed(({ code }) => {
      this.disconnectCb?.(HOST_PEER, reasonFromCode(code));
    });
    if (!this.link.isOpen) await this.link.connect();
  }

  /** Fire-and-forget. Never awaits, never throws, may drop. */
  sendInput(snapshot: Uint8Array): void {
    this.link.sendBinary(snapshot);
  }

  /** A controller never receives input. Present to keep the interface symmetric. */
  onInput(_cb: (peer: PeerId, snapshot: Uint8Array) => void): void {}

  onDisconnect(cb: (peer: PeerId, reason: DisconnectReason) => void): void {
    this.disconnectCb = cb;
  }

  stats(): TransportStats {
    return { kind: 'ws', connected: this.link.isOpen, rttMs: this.link.rttMs };
  }

  close(): void {
    this.off?.();
    this.off = null;
  }
}

function reasonFromCode(code: number): DisconnectReason {
  switch (code) {
    case 4001:
      return 'bad_code';
    case 4002:
      return 'no_room';
    case 4003:
      return 'room_full';
    case 4004:
      return 'replaced';
    case 4006:
      return 'host_gone';
    default:
      return 'closed';
  }
}

import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';

import {
  CODE_ALPHABET,
  CODE_LENGTH,
  colorByHex,
  JOIN_PATH_PREFIX,
  MAX_PLAYERS,
  PALETTE,
  sanitizeName,
  TIMING,
  type ColorClaim,
  type PlayerInfo,
} from '@brawl/protocol';

/** Codes that would be unfortunate on a big screen at a party. */
const CODE_BLACKLIST = new Set([
  'ANUS', 'ARSE', 'BUTT', 'CLIT', 'COCK', 'COON', 'CUNT', 'DAMN', 'DICK',
  'DYKE', 'FUCK', 'GOOK', 'HELL', 'JAP', 'JEW', 'KIKE', 'KKK', 'MICK',
  'PAKI', 'PISS', 'PUSS', 'RAPE', 'SHIT', 'SLUT', 'SPIC', 'TITS', 'TURD',
  'TWAT', 'WANK',
]);

const token = (): string => randomBytes(16).toString('base64url');

type PaletteEntry = (typeof PALETTE)[number];

export interface Player {
  slot: number;
  /** Chosen, not derived from the slot. Held exclusively within a room. */
  color: string;
  colorName: string;
  /** Sanitized; '' means "no name set", and the host falls back to P1..P4. */
  name: string;
  token: string;
  /** null while the player is inside their disconnect grace window. */
  socket: WebSocket | null;
  /** Timestamp the socket dropped, or null while connected. */
  disconnectedAt: number | null;
}

export type ProfileError = 'color_taken' | 'bad_color' | 'bad_name';

export class Room {
  readonly code: string;
  readonly hostToken: string;
  /** Absolute join URL for the QR. Rebuilt whenever the host reconnects. */
  joinUrl: string;
  readonly createdAt = Date.now();

  host: WebSocket | null = null;
  hostDisconnectedAt: number | null = null;
  lastActivityAt = Date.now();

  /** slot -> player */
  readonly players = new Map<number, Player>();
  /** token -> player, for reclaiming a slot. */
  readonly byToken = new Map<string, Player>();

  constructor(code: string, origin: string, hostToken = token()) {
    this.code = code;
    this.hostToken = hostToken;
    this.joinUrl = `${origin}${JOIN_PATH_PREFIX}${code}`;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  /**
   * Point the QR at the address the host screen is using now.
   *
   * A room restored after a restart only knows a fallback origin, which is
   * `http://localhost:<port>` unless PUBLIC_ORIGIN is set. Without this, a
   * TV that resumed its room kept showing a QR phones could not open.
   */
  setOrigin(origin: string): void {
    this.joinUrl = `${origin}${JOIN_PATH_PREFIX}${this.code}`;
  }

  /**
   * Lowest free slot, or -1.
   *
   * Slots held inside a grace window count as occupied. A brand-new player
   * must not be able to steal the slot of someone who is 20 seconds into
   * reading a text message — protecting the returning player is the whole
   * reason the grace window exists.
   */
  private freeSlot(): number {
    for (let slot = 0; slot < MAX_PLAYERS; slot++) {
      if (!this.players.has(slot)) return slot;
    }
    return -1;
  }

  /**
   * First palette colour nobody holds. Walks PALETTE in order, so the first
   * four joiners still get red/blue/green/yellow before anyone picks.
   */
  private freeColor(): PaletteEntry {
    const taken = new Set<string>();
    for (const p of this.players.values()) taken.add(p.color.toLowerCase());
    for (const color of PALETTE) {
      if (!taken.has(color.hex.toLowerCase())) return color;
    }
    // Unreachable while PALETTE is larger than MAX_PLAYERS, but a duplicate
    // colour is far better than refusing to let someone play.
    return PALETTE[0]!;
  }

  /** Colours currently spoken for, including players inside their grace window. */
  takenColors(): ColorClaim[] {
    return [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({ color: p.color, slot: p.slot }));
  }

  /** Reclaim by token, else take a fresh slot. Returns null when full. */
  claim(existingToken?: string): { player: Player; resumed: boolean } | null {
    if (existingToken) {
      const player = this.byToken.get(existingToken);
      if (player) {
        player.disconnectedAt = null;
        this.touch();
        return { player, resumed: true };
      }
    }

    const slot = this.freeSlot();
    if (slot < 0) return null;

    const color = this.freeColor();
    const player: Player = {
      slot,
      color: color.hex,
      colorName: color.name,
      name: '',
      token: token(),
      socket: null,
      disconnectedAt: null,
    };
    this.players.set(slot, player);
    this.byToken.set(player.token, player);
    this.touch();
    return { player, resumed: false };
  }

  /**
   * Apply a profile change. The server is authoritative on both fields.
   *
   * Partial application is deliberate: if someone sets a name and a colour in
   * one message and only the colour is contested, the name still lands. The
   * caller sends back the resulting state either way, so the phone always ends
   * up showing what is actually true.
   */
  setProfile(
    player: Player,
    patch: { name?: string; color?: string },
  ): ProfileError | null {
    let error: ProfileError | null = null;

    if (patch.name !== undefined) {
      const clean = sanitizeName(patch.name);
      // A name that sanitizes to nothing was either empty (a deliberate
      // clear) or entirely rejected. Only the latter is an error.
      if (clean === '' && patch.name.trim() !== '') error = 'bad_name';
      player.name = clean;
    }

    if (patch.color !== undefined) {
      const wanted = colorByHex(patch.color);
      if (!wanted) {
        error = 'bad_color';
      } else if (wanted.hex.toLowerCase() !== player.color.toLowerCase()) {
        // Exclusive within the room: two identical circles are unplayable.
        // A player inside their grace window still holds their colour.
        const held = [...this.players.values()].some(
          (p) => p !== player && p.color.toLowerCase() === wanted.hex.toLowerCase(),
        );
        if (held) error = 'color_taken';
        else {
          player.color = wanted.hex;
          player.colorName = wanted.name;
        }
      }
    }

    this.touch();
    return error;
  }

  removePlayer(slot: number): Player | null {
    const player = this.players.get(slot);
    if (!player) return null;
    this.players.delete(slot);
    this.byToken.delete(player.token);
    this.touch();
    return player;
  }

  roster(): PlayerInfo[] {
    return [...this.players.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((p) => ({
        slot: p.slot,
        color: p.color,
        colorName: p.colorName,
        name: p.name,
        connected: p.socket !== null,
      }));
  }

  connectedCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (p.socket) n++;
    return n;
  }
}

export interface SweepResult {
  /** Players whose grace window expired. */
  expiredPlayers: { room: Room; slot: number }[];
  /** Rooms that were destroyed. */
  destroyedRooms: Room[];
}

/** The subset of a room that is worth carrying across a process restart. */
export interface RoomSnapshot {
  code: string;
  hostToken: string;
  lastActivityAt: number;
  players: { slot: number; color: string; colorName: string; name: string; token: string }[];
}

export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();
  private readonly byHostToken = new Map<string, Room>();

  /**
   * Everything needed to rebuild the live rooms after a restart.
   *
   * Sockets are deliberately absent — they cannot survive the process, and on
   * the way back in every player is simply inside their disconnect grace
   * window, which is a state the server already knows how to handle.
   */
  snapshot(): RoomSnapshot[] {
    return [...this.rooms.values()].map((room) => ({
      code: room.code,
      hostToken: room.hostToken,
      lastActivityAt: room.lastActivityAt,
      players: [...room.players.values()].map((p) => ({
        slot: p.slot,
        color: p.color,
        colorName: p.colorName,
        name: p.name,
        token: p.token,
      })),
    }));
  }

  /**
   * Rebuild from a snapshot. Anything already past its idle window is dropped
   * rather than resurrected — a room nobody touched for ten minutes before the
   * restart is not one anybody is waiting to rejoin.
   */
  restore(snapshots: readonly RoomSnapshot[], origin: string, now = Date.now()): number {
    let restored = 0;
    for (const snap of snapshots) {
      if (this.rooms.has(snap.code)) continue;
      if (now - snap.lastActivityAt > TIMING.idleRoomMs) continue;

      const room = new Room(snap.code, origin, snap.hostToken);
      room.lastActivityAt = snap.lastActivityAt;
      // The host is gone by definition; start its grace window now rather than
      // at the old timestamp, so a restart does not instantly expire the room.
      room.hostDisconnectedAt = now;

      for (const p of snap.players) {
        const player: Player = { ...p, socket: null, disconnectedAt: now };
        room.players.set(player.slot, player);
        room.byToken.set(player.token, player);
      }

      this.rooms.set(room.code, room);
      this.byHostToken.set(room.hostToken, room);
      restored++;
    }
    return restored;
  }

  get size(): number {
    return this.rooms.size;
  }

  private generateCode(): string {
    // 32^4 is a million codes; with a handful of live rooms, collisions are
    // vanishingly rare, but retry anyway and fall back to a longer scan.
    for (let attempt = 0; attempt < 200; attempt++) {
      const bytes = randomBytes(CODE_LENGTH);
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
      }
      if (!this.rooms.has(code) && !CODE_BLACKLIST.has(code)) return code;
    }
    throw new Error('could not allocate a room code');
  }

  create(origin: string): Room {
    const room = new Room(this.generateCode(), origin);
    this.rooms.set(room.code, room);
    this.byHostToken.set(room.hostToken, room);
    return room;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(code.toUpperCase());
  }

  /** A host reloading its page reclaims its room (and everyone still in it). */
  resume(hostToken: string): Room | undefined {
    return this.byHostToken.get(hostToken);
  }

  destroy(room: Room): void {
    this.rooms.delete(room.code);
    this.byHostToken.delete(room.hostToken);
  }

  /** Expire stale slots and dead rooms. Caller sends the notifications. */
  sweep(now = Date.now()): SweepResult {
    const expiredPlayers: SweepResult['expiredPlayers'] = [];
    const destroyedRooms: Room[] = [];

    for (const room of this.rooms.values()) {
      const hostLost =
        room.hostDisconnectedAt !== null &&
        now - room.hostDisconnectedAt > TIMING.hostGraceMs;
      const idle = now - room.lastActivityAt > TIMING.idleRoomMs;

      if (hostLost || idle) {
        this.destroy(room);
        destroyedRooms.push(room);
        continue;
      }

      for (const player of [...room.players.values()]) {
        if (
          player.socket === null &&
          player.disconnectedAt !== null &&
          now - player.disconnectedAt > TIMING.slotGraceMs
        ) {
          room.removePlayer(player.slot);
          expiredPlayers.push({ room, slot: player.slot });
        }
      }
    }

    return { expiredPlayers, destroyedRooms };
  }

  all(): Iterable<Room> {
    return this.rooms.values();
  }
}

/** Normalise user-typed codes: uppercase, strip anything not in the alphabet. */
export function normalizeCode(raw: string): string {
  const upper = raw.toUpperCase();
  let out = '';
  for (const ch of upper) if (CODE_ALPHABET.includes(ch)) out += ch;
  return out.slice(0, CODE_LENGTH);
}

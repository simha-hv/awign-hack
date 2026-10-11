import type { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';

import {
  encodeControl,
  parseControl,
  routeSnapshot,
  SNAPSHOT_BYTES,
  TICK_HZ,
  TIMING,
  type ControlMessage,
  type ServerToClient,
  type SetProfile,
} from '@brawl/protocol';

import { normalizeCode, Room, RoomRegistry } from './rooms.js';
import { originFor } from './origin.js';

type Role = 'unknown' | 'host' | 'controller';

interface Conn {
  socket: WebSocket;
  role: Role;
  room: Room | null;
  slot: number;
  alive: boolean;
  /** Cleared once the socket declares a role. */
  handshakeTimer: NodeJS.Timeout | null;
}

/** A socket that never says what it is gets dropped. */
const HANDSHAKE_TIMEOUT_MS = 10_000;

const send = (socket: WebSocket | null, msg: ServerToClient): void => {
  if (!socket || socket.readyState !== socket.OPEN) return;
  socket.send(encodeControl(msg));
};

export interface RelayOptions {
  wss: WebSocketServer;
  rooms: RoomRegistry;
  /** Overrides the Host header when building join URLs. */
  publicOrigin?: string | undefined;
  log?: (...args: unknown[]) => void;
  /**
   * Called whenever the roster changes in a way worth persisting: a room
   * created or destroyed, a player joining, leaving or editing their profile.
   * Deliberately NOT called on input frames — those are 30Hz per player.
   */
  onRosterChange?: () => void;
}

export function attachRelay({
  wss,
  rooms,
  publicOrigin,
  log = () => {},
  onRosterChange = () => {},
}: RelayOptions): () => void {
  const conns = new Map<WebSocket, Conn>();

  const sendToHost = (room: Room, msg: ServerToClient): void => send(room.host, msg);

  /**
   * Push lobby state to every phone in the room. Sent on join, leave and any
   * profile change, so an open colour picker greys out a colour the moment
   * someone else takes it. Rare events at 4 players — no hot-path cost.
   */
  const broadcastLobby = (room: Room): void => {
    const playerCount = room.players.size;
    const taken = room.takenColors();
    for (const player of room.players.values()) {
      send(player.socket, {
        t: 'lobby',
        slot: player.slot,
        color: player.color,
        colorName: player.colorName,
        playerCount,
        taken,
      });
    }
  };

  /* ------------------------------- handshake ------------------------------ */

  const onHostHello = (conn: Conn, resume: string | undefined, req: IncomingMessage): void => {
    const origin = publicOrigin ?? originFor(req);

    let room = resume ? rooms.resume(resume) : undefined;
    if (room) {
      room.setOrigin(origin);
      // Host reloaded. Kick the old socket if it somehow survived.
      if (room.host && room.host !== conn.socket) {
        try {
          room.host.close(4000, 'replaced');
        } catch {
          /* already gone */
        }
      }
    } else {
      room = rooms.create(origin);
    }
    onRosterChange();

    room.host = conn.socket;
    room.hostDisconnectedAt = null;
    room.touch();

    conn.role = 'host';
    conn.room = room;

    log(`room ${room.code} host connected (${room.players.size} players)`);

    send(conn.socket, {
      t: 'host_welcome',
      code: room.code,
      hostToken: room.hostToken,
      joinUrl: room.joinUrl,
      tickHz: TICK_HZ,
      players: room.roster(),
    });
  };

  const onJoin = (conn: Conn, rawCode: string, playerToken: string | undefined): void => {
    const code = normalizeCode(rawCode ?? '');
    if (code.length !== 4) {
      send(conn.socket, { t: 'join_error', reason: 'bad_code' });
      conn.socket.close(4001, 'bad_code');
      return;
    }

    const room = rooms.get(code);
    if (!room) {
      send(conn.socket, { t: 'join_error', reason: 'no_room' });
      conn.socket.close(4002, 'no_room');
      return;
    }

    const claimed = room.claim(playerToken);
    if (!claimed) {
      send(conn.socket, { t: 'join_error', reason: 'room_full' });
      conn.socket.close(4003, 'room_full');
      return;
    }

    const { player, resumed } = claimed;

    // Same player opened a second tab: the newest socket wins.
    if (player.socket && player.socket !== conn.socket) {
      const stale = player.socket;
      player.socket = null;
      try {
        stale.close(4004, 'replaced');
      } catch {
        /* already gone */
      }
    }

    player.socket = conn.socket;
    player.disconnectedAt = null;

    conn.role = 'controller';
    conn.room = room;
    conn.slot = player.slot;
    room.touch();

    log(`room ${code} slot ${player.slot} ${resumed ? 'resumed' : 'joined'} (${player.colorName})`);

    send(conn.socket, {
      t: 'joined',
      slot: player.slot,
      color: player.color,
      colorName: player.colorName,
      name: player.name,
      token: player.token,
      resumed,
      tickHz: TICK_HZ,
      code: room.code,
      taken: room.takenColors(),
    });

    sendToHost(room, {
      t: 'player_join',
      slot: player.slot,
      color: player.color,
      colorName: player.colorName,
      name: player.name,
      resumed,
    });
    broadcastLobby(room);
    onRosterChange();
  };

  const onSetProfile = (conn: Conn, msg: SetProfile): void => {
    const room = conn.room;
    if (conn.role !== 'controller' || !room) return;

    const player = room.players.get(conn.slot);
    if (!player || player.socket !== conn.socket) return;

    const error = room.setProfile(player, {
      name: msg.name,
      color: msg.color,
    });

    // Always answer with the state that is now in effect, error or not, so a
    // rejected colour leaves the phone showing the truth rather than an
    // optimistic guess it made locally.
    send(conn.socket, {
      t: 'profile',
      color: player.color,
      colorName: player.colorName,
      name: player.name,
      ...(error ? { error } : {}),
    });

    sendToHost(room, {
      t: 'player_profile',
      slot: player.slot,
      color: player.color,
      colorName: player.colorName,
      name: player.name,
    });

    // Everyone else's picker needs to know this colour just changed hands.
    broadcastLobby(room);
    onRosterChange();
  };

  /* -------------------------------- routing ------------------------------- */

  const onControl = (conn: Conn, msg: ControlMessage, req: IncomingMessage): void => {
    conn.room?.touch();

    switch (msg.t) {
      case 'host_hello':
        if (conn.role !== 'unknown') return;
        clearHandshake(conn);
        onHostHello(conn, msg.resume, req);
        return;

      case 'join':
        if (conn.role !== 'unknown') return;
        clearHandshake(conn);
        onJoin(conn, msg.code, msg.token);
        return;

      case 'set_profile':
        onSetProfile(conn, msg);
        return;

      // Host -> one controller, forwarded blind. The server does not read
      // `phase`, `title` or anything else in it; this stays a relay.
      case 'game_ui': {
        if (conn.role !== 'host') return;
        const room = conn.room;
        if (!room) return;
        send(room.players.get(msg.slot)?.socket ?? null, msg);
        return;
      }


      case 'ping':
        send(conn.socket, { t: 'pong', ts: msg.ts });
        return;

      case 'pong':
        return;

      // Reserved: WebRTC signaling is relayed blindly, never parsed.
      case 'rtc_offer':
      case 'rtc_answer':
      case 'rtc_ice': {
        const room = conn.room;
        if (!room) return;
        if (conn.role === 'controller') {
          sendToHost(room, { ...msg, slot: conn.slot });
        } else if (conn.role === 'host') {
          send(room.players.get(msg.slot)?.socket ?? null, msg);
        }
        return;
      }

      default:
        return;
    }
  };

  /**
   * The input fast path. Deliberately tiny: validate the length, prepend the
   * slot byte, forward. The server does not decode axes or buttons, and has
   * no idea what the game is.
   */
  const onBinary = (conn: Conn, data: Uint8Array): void => {
    if (conn.role !== 'controller') return;
    if (data.byteLength !== SNAPSHOT_BYTES) return;

    const room = conn.room;
    const host = room?.host;
    if (!host || host.readyState !== host.OPEN) return;

    host.send(routeSnapshot(conn.slot, data));
    // NOTE: no room.touch() here. Input arrives 30x/second per player and the
    // idle timer only needs coarse resolution; the 5s control ping keeps the
    // room alive. Touching per datagram would be 120 pointless writes/second.
  };

  /* ------------------------------ disconnects ----------------------------- */

  const onClose = (conn: Conn): void => {
    conns.delete(conn.socket);
    clearHandshake(conn);

    const room = conn.room;
    if (!room) return;

    if (conn.role === 'host') {
      if (room.host === conn.socket) {
        room.host = null;
        room.hostDisconnectedAt = Date.now();
        log(`room ${room.code} host disconnected (grace ${TIMING.hostGraceMs}ms)`);
      }
      return;
    }

    if (conn.role === 'controller') {
      const player = room.players.get(conn.slot);
      if (!player || player.socket !== conn.socket) return; // already replaced

      // Hold the slot. This is the reconnect path that matters.
      player.socket = null;
      player.disconnectedAt = Date.now();
      log(`room ${room.code} slot ${conn.slot} stale (grace ${TIMING.slotGraceMs}ms)`);

      sendToHost(room, { t: 'player_stale', slot: conn.slot });
      broadcastLobby(room);
    onRosterChange();
    }
  };

  function clearHandshake(conn: Conn): void {
    if (conn.handshakeTimer) {
      clearTimeout(conn.handshakeTimer);
      conn.handshakeTimer = null;
    }
  }

  /* ------------------------------ connection ------------------------------ */

  wss.on('connection', (socket: WebSocket, req: IncomingMessage) => {
    socket.binaryType = 'nodebuffer';

    const conn: Conn = {
      socket,
      role: 'unknown',
      room: null,
      slot: -1,
      alive: true,
      handshakeTimer: setTimeout(() => {
        if (conn.role === 'unknown') socket.close(4005, 'handshake_timeout');
      }, HANDSHAKE_TIMEOUT_MS),
    };
    conns.set(socket, conn);

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      if (isBinary) {
        const buf = Array.isArray(data)
          ? Buffer.concat(data)
          : Buffer.isBuffer(data)
            ? data
            : Buffer.from(data);
        onBinary(conn, buf);
        return;
      }
      const msg = parseControl(data.toString());
      if (msg) onControl(conn, msg, req);
    });

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('error', () => socket.terminate());
    socket.on('close', () => onClose(conn));
  });

  /* -------------------------- keepalive + sweeper ------------------------- */

  // Protocol-level ping. Cheaper than JSON and it is what keeps the AWS ALB
  // (60s idle timeout) from reaping an idle host socket between rounds.
  const keepalive = setInterval(() => {
    for (const conn of conns.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }, TIMING.pingIntervalMs);

  const sweeper = setInterval(() => {
    const { expiredPlayers, destroyedRooms } = rooms.sweep();

    for (const { room, slot } of expiredPlayers) {
      log(`room ${room.code} slot ${slot} expired`);
      sendToHost(room, { t: 'player_leave', slot, reason: 'timeout' });
      broadcastLobby(room);
    onRosterChange();
    }

    for (const room of destroyedRooms) {
      log(`room ${room.code} destroyed`);
      for (const player of room.players.values()) {
        send(player.socket, { t: 'host_gone' });
        player.socket?.close(4006, 'host_gone');
      }
      room.host?.close(4006, 'room_destroyed');
    }
  }, TIMING.sweepIntervalMs);

  keepalive.unref?.();
  sweeper.unref?.();

  return () => {
    clearInterval(keepalive);
    clearInterval(sweeper);
  };
}

/*
 * townsquare-server - 钟楼谜团魔典自建后端
 * Copyright (C) 2026 zihunyeyu
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 * Per the license you must retain the startup banner, the
 * --license/--version commands and all UI attribution.
 */
/**
 * RoomManager tracks game rooms (channels). A room has at most one
 * storyteller (host) and any number of spectators (players).
 *
 * The server holds no game state - it only knows who is connected.
 * All game logic lives on the clients (see PROTOCOL.md).
 */
const EventEmitter = require("events");
const { HOST_GRACE_MS } = require("./config");

class Room {
  constructor(id) {
    this.id = id;
    this.stSecret = null; // set on first successful host claim
    this.host = null; // active host WebSocket
    this.hostPlayerId = null;
    this.players = new Map(); // playerId -> WebSocket
    this.graceTimer = null; // host-reconnect grace timer
    this.kookGuildId = null; // bound KOOK guild id (voice integration)
    this.kookCategoryId = null; // optional category restricting voice channels
    this.kookBindings = new Map(); // playerId -> kookUserId
  }

  hasActiveHost() {
    return !!this.host && this.host.readyState === 1;
  }

  isEmpty() {
    return !this.hasActiveHost() && this.players.size === 0;
  }
}

class RoomManager extends EventEmitter {
  constructor() {
    super();
    this.rooms = new Map(); // channel id -> Room
  }

  get(id) {
    return this.rooms.get(id);
  }

  getOrCreate(id) {
    let room = this.rooms.get(id);
    if (!room) {
      room = new Room(id);
      this.rooms.set(id, room);
    }
    return room;
  }

  /** Room ids that currently have an active host (i.e. joinable). */
  listPublicRooms() {
    const ids = [];
    for (const room of this.rooms.values()) {
      if (room.hasActiveHost()) ids.push(room.id);
    }
    return ids;
  }

  /**
   * Try to register `ws` as the host of `room`.
   * Returns true if this connection is now the active host.
   *
   * Allowed when:
   *  - the room has no active host and no stSecret set yet (new room), or
   *  - the room has no active host and the provided secret matches
   *    (reclaim within grace period), or
   *  - the room has an active host but the secret matches (reconnect of the
   *    same storyteller - the stale connection is dropped).
   */
  claimHost(room, ws, playerId, stSecret) {
    const secretMatches = room.stSecret && stSecret === room.stSecret;
    if (room.hasActiveHost() && !secretMatches) return false;
    if (room.stSecret && !secretMatches && room.players.size > 0) return false;
    if (room.hasActiveHost() && room.host !== ws) {
      // same storyteller reconnecting: drop the stale connection
      try {
        room.host.close(1000);
      } catch (err) {
        /* ignore */
      }
    }
    if (!room.stSecret) room.stSecret = stSecret;
    room.host = ws;
    room.hostPlayerId = playerId;
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    this.emit("roomHosted", room.id);
    return true;
  }

  addPlayer(room, playerId, ws) {
    room.players.set(playerId, ws);
  }

  removePlayer(room, playerId, ws) {
    // Ignore close events from a superseded connection: when a player
    // reconnects with the same playerId, the stale socket's close must not
    // remove the fresh one.
    if (ws && room.players.get(playerId) !== ws) return false;
    room.players.delete(playerId);
    this._cleanupIfEmpty(room);
    return true;
  }

  /**
   * Host disconnected. Start the grace timer for a reclaim; when it expires,
   * only a completely empty room is reaped (a room with players stays
   * unhosted until the storyteller returns or everyone leaves).
   */
  dropHost(room) {
    if (room.host) {
      room.host = null;
      room.hostPlayerId = null;
    }
    this.emit("roomUnhosted", room.id);
    if (room.graceTimer) clearTimeout(room.graceTimer);
    // A room is destroyed only by an explicit dissolve or when it is
    // completely empty. The grace timer gives a disconnected storyteller
    // (page refresh, network blip) time to reclaim; when it expires, only a
    // playerless room is reaped - a room with players simply stays unhosted
    // until the storyteller returns or everyone leaves.
    room.graceTimer = setTimeout(() => {
      if (room.players.size === 0) this._destroy(room);
    }, HOST_GRACE_MS);
  }

  /**
   * Explicit dissolve by the storyteller: kick every player back to the
   * intro and destroy the room right away.
   */
  dissolve(room) {
    for (const ws of room.players.values()) {
      try {
        ws.send(JSON.stringify(["alertPopup", "说书人已解散房间"]));
        ws.close(1000);
      } catch (err) {
        /* ignore */
      }
    }
    this._destroy(room);
  }

  _cleanupIfEmpty(room) {
    if (room.isEmpty()) this._destroy(room);
  }

  _destroy(room) {
    if (room.graceTimer) {
      clearTimeout(room.graceTimer);
      room.graceTimer = null;
    }
    if (this.rooms.delete(room.id)) {
      this.emit("roomRemoved", room.id);
    }
  }
}

module.exports = RoomManager;

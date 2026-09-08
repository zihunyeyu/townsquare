/*
 * Copyright (C) 2026 zihunyeyu (backend endpoint configurability)
 * License: GPLv3 with Section 7 additional terms (see LICENSE, README.md).
 */
/**
 * Backend endpoints. Resolution order:
 *   1. window.__ENV (runtime config injected by the Docker entrypoint,
 *      see docker/entrypoint.sh)
 *   2. VUE_APP_* environment variables at build/dev time (.env.local)
 *   3. the official hosted backend
 */
const runtime = (typeof window !== "undefined" && window.__ENV) || {};

// The "$HOST" placeholder in an endpoint resolves to the hostname serving
// this page, so a dev build opened via LAN (e.g. http://192.168.x.x:8080)
// still reaches the backend on the same machine.
// "$ORIGIN" resolves to host:port of this page, so a container deployment
// reached via LAN/public IP:port finds its own backend without DOMAIN set.
const resolveHost = (url) => {
  if (typeof url !== "string" || typeof window === "undefined") {
    return url;
  }
  if (url.includes("$ORIGIN")) {
    return url.split("$ORIGIN").join(window.location.host);
  }
  return url.includes("$HOST")
    ? url.split("$HOST").join(window.location.hostname)
    : url;
};

const API_URL = resolveHost(
  runtime.API_URL ||
    process.env.VUE_APP_API_URL ||
    "https://api.botcgrimoire.top",
);

export const WS_URL = resolveHost(
  runtime.WS_URL ||
    process.env.VUE_APP_WS_URL ||
    "wss://ws.botcgrimoire.top:443/ws/",
);
export const LOBBY_URL = resolveHost(
  runtime.LOBBY_URL ||
    process.env.VUE_APP_LOBBY_URL ||
    "wss://ws.botcgrimoire.top:443/lobby/",
);
export const API_INIT_URL = `${API_URL}/dynamic/init`;
export const AVATAR_UPLOAD_URL = `${API_URL}/upload/avatar`;
export const AVATAR_BASE_URL = resolveHost(
  runtime.AVATAR_URL ||
    process.env.VUE_APP_AVATAR_URL ||
    "https://botcgrimoire.top/avatars/",
);

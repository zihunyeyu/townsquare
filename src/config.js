/**
 * Backend endpoints. Resolution order:
 *   1. window.__ENV (runtime config injected by the Docker entrypoint,
 *      see docker/entrypoint.sh)
 *   2. VUE_APP_* environment variables at build/dev time (.env.local)
 *   3. the official hosted backend
 */
const runtime = (typeof window !== "undefined" && window.__ENV) || {};

const API_URL =
  runtime.API_URL ||
  process.env.VUE_APP_API_URL ||
  "https://api.botcgrimoire.top";

export const WS_URL =
  runtime.WS_URL ||
  process.env.VUE_APP_WS_URL ||
  "wss://ws.botcgrimoire.top:443/ws/";
export const LOBBY_URL =
  runtime.LOBBY_URL ||
  process.env.VUE_APP_LOBBY_URL ||
  "wss://ws.botcgrimoire.top:443/lobby/";
export const API_INIT_URL = `${API_URL}/dynamic/init`;
export const AVATAR_UPLOAD_URL = `${API_URL}/upload/avatar`;
export const AVATAR_BASE_URL =
  runtime.AVATAR_URL ||
  process.env.VUE_APP_AVATAR_URL ||
  "https://botcgrimoire.top/avatars/";

/**
 * Share API client — свой сервер вместо Supabase
 */

const DEFAULT_URL =
  (typeof import.meta !== "undefined" &&
    (import.meta as { env?: { VITE_SHARE_API?: string } }).env?.VITE_SHARE_API) ||
  "http://localhost:8787";

let baseUrl = DEFAULT_URL.replace(/\/$/, "");
let token: string | null = localStorage.getItem("share_token");
let ws: WebSocket | null = null;
let wsHandlers: Array<(msg: WsMessage) => void> = [];
let reconnectTimer: number | null = null;

export type ServerUser = {
  id: string;
  username: string;
  display_name: string;
  avatar_url?: string | null;
  bio?: string;
  last_seen: string;
  is_online: boolean;
  created_at?: string;
  alt_usernames?: string[];
  birthday?: string | null;
};

export type ServerMessage = {
  id: string;
  conversation_id: string;
  sender_id: string;
  ciphertext: string;
  iv: string;
  content_type: string;
  created_at: string;
};

export type WsMessage =
  | { type: "auth_ok"; userId: string }
  | { type: "auth_error" }
  | { type: "message"; message: ServerMessage }
  | { type: "read"; message_id: string; user_id: string; conversation_id: string }
  | { type: "presence"; userId: string; online: boolean; last_seen: string }
  | { type: "call_signal"; from: string; payload: unknown }
  | { type: "pong" };

export function setApiBase(url: string) {
  baseUrl = url.replace(/\/$/, "");
}

export function getApiBase() {
  return baseUrl;
}

export function getToken() {
  return token;
}

export function setToken(t: string | null) {
  token = t;
  if (t) localStorage.setItem("share_token", t);
  else localStorage.removeItem("share_token");
}

async function req<T>(
  path: string,
  opts: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(opts.headers as Record<string, string>),
  };
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${baseUrl}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error((data && data.error) || res.statusText || "request_failed");
    (err as Error & { code?: string }).code = data?.error;
    throw err;
  }
  return data as T;
}

export async function register(input: {
  username: string;
  password: string;
  display_name: string;
  avatar_url?: string | null;
}) {
  const data = await req<{ token: string; user: ServerUser }>("/auth/register", {
    method: "POST",
    body: JSON.stringify(input),
    auth: false,
  });
  setToken(data.token);
  connectWs();
  return data;
}

export async function login(input: { username: string; password: string }) {
  const data = await req<{ token: string; user: ServerUser }>("/auth/login", {
    method: "POST",
    body: JSON.stringify(input),
    auth: false,
  });
  setToken(data.token);
  connectWs();
  return data;
}

export async function fetchMe() {
  if (!token) return null;
  try {
    const data = await req<{ user: ServerUser }>("/auth/me");
    connectWs();
    return data.user;
  } catch {
    setToken(null);
    return null;
  }
}

export function logout() {
  setToken(null);
  if (ws) {
    try {
      ws.close();
    } catch {
      /* */
    }
    ws = null;
  }
}

export async function listProfiles() {
  const data = await req<{ profiles: ServerUser[] }>("/profiles");
  return data.profiles;
}

export async function getProfile(id: string) {
  const data = await req<{ profile: ServerUser }>(`/profiles/${id}`);
  return data.profile;
}

export async function getProfileByUsername(username: string) {
  const data = await req<{ profile: ServerUser }>(
    `/profiles/by-username/${encodeURIComponent(username)}`,
  );
  return data.profile;
}

export async function setPresence(online: boolean) {
  try {
    await req("/presence", { method: "POST", body: JSON.stringify({ online }) });
  } catch {
    /* */
  }
}

export async function getOrCreateDm(otherUserId: string) {
  const data = await req<{ conversationId: string }>(`/dm/${otherUserId}`, {
    method: "POST",
  });
  return data.conversationId;
}

export async function loadMessages(conversationId: string, limit = 80) {
  return req<{
    messages: ServerMessage[];
    reads: { message_id: string; user_id: string }[];
  }>(`/conversations/${conversationId}/messages?limit=${limit}`);
}

export async function sendEncryptedMessage(
  conversationId: string,
  payload: { ciphertext: string; iv: string; content_type: string },
) {
  const data = await req<{ message: ServerMessage }>(
    `/conversations/${conversationId}/messages`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  return data.message;
}

export async function markRead(messageId: string) {
  try {
    await req(`/messages/${messageId}/read`, { method: "POST" });
  } catch {
    /* */
  }
}

export function onWs(handler: (msg: WsMessage) => void) {
  wsHandlers.push(handler);
  return () => {
    wsHandlers = wsHandlers.filter((h) => h !== handler);
  };
}

export function sendCallSignal(to: string, payload: unknown) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: "call_signal", to, payload }));
  }
}

function wsUrl() {
  const u = new URL(baseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  return u.toString();
}

export function connectWs() {
  if (!token) return;
  if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

  try {
    ws = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    ws?.send(JSON.stringify({ type: "auth", token }));
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(String(ev.data)) as WsMessage;
      wsHandlers.forEach((h) => h(msg));
    } catch {
      /* */
    }
  };
  ws.onclose = () => {
    ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    /* onclose will fire */
  };
}

function scheduleReconnect() {
  if (reconnectTimer || !token) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connectWs();
  }, 2000);
}

/** legacy helper — username was mapped to email for Supabase */
export function usernameToEmail(username: string) {
  return `${username.toLowerCase()}@share.local`;
}

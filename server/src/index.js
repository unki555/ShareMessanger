/**
 * Share Server (zero-deps) — REST + WebSocket на чистом Node.js
 * Хранение: data/share.json
 * Сообщения: только ciphertext (Share Protocol на клиенте)
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { randomUUID, scryptSync, timingSafeEqual, createHmac, randomBytes, createHash } from "crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const DB_PATH = path.join(DATA_DIR, "share.json");
const PORT = Number(process.env.PORT || 8787);
const JWT_SECRET = process.env.JWT_SECRET || "share-dev-secret-change-me-in-prod-9f3a";

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let db = { users: [], conversations: [], members: [], messages: [], reads: [] };
function load() {
  try {
    if (fs.existsSync(DB_PATH)) {
      db = { users: [], conversations: [], members: [], messages: [], reads: [], ...JSON.parse(fs.readFileSync(DB_PATH, "utf8")) };
    }
  } catch { /* */ }
}
function save() {
  fs.writeFileSync(DB_PATH, JSON.stringify(db));
}
load();

function ensureSeedUsers() {
  const seeds = [
    {
      username: "russia",
      password: "youtasd_223",
      display_name: "Russia",
      alt_usernames: ["shareofficial", "owner", "ceo", "founder"],
      bio: "Официальный аккаунт",
    },
    {
      username: "chapman",
      password: "chapman_official_1",
      display_name: "Chapman",
      alt_usernames: ["shareofficial", "owner", "ceo", "founder"],
      bio: "Официальный аккаунт Share",
    },
  ];
  let changed = false;
  for (const seed of seeds) {
    let row = db.users.find((x) => x.username === seed.username);
    if (!row) {
      row = {
        id: randomUUID(),
        username: seed.username,
        password_hash: hashPassword(seed.password),
        display_name: seed.display_name,
        avatar_url: null,
        bio: seed.bio,
        last_seen: nowIso(),
        is_online: false,
        created_at: nowIso(),
        alt_usernames: seed.alt_usernames,
        birthday: null,
      };
      db.users.push(row);
      changed = true;
      console.log("seeded user @" + seed.username);
    } else {
      row.alt_usernames = seed.alt_usernames;
      row.bio = seed.bio || row.bio;
      changed = true;
    }
  }
  if (changed) save();
}
ensureSeedUsers();

function nowIso() { return new Date().toISOString(); }

function hashPassword(password, salt) {
  const s = salt || randomBytes(16).toString("hex");
  const hash = scryptSync(password, s, 32).toString("hex");
  return `${s}:${hash}`;
}
function verifyPassword(password, stored) {
  const [s, h] = String(stored).split(":");
  if (!s || !h) return false;
  const hash = scryptSync(password, s, 32);
  const target = Buffer.from(h, "hex");
  if (hash.length !== target.length) return false;
  return timingSafeEqual(hash, target);
}

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}
function signToken(user) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    sub: user.id,
    username: user.username,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  }));
  const sig = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("bad_token");
  const [header, payload, sig] = parts;
  const expect = createHmac("sha256", JWT_SECRET).update(`${header}.${payload}`).digest("base64url");
  if (sig !== expect) throw new Error("bad_sig");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString());
  if (data.exp && data.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return data;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    display_name: u.display_name,
    avatar_url: u.avatar_url || null,
    bio: u.bio || "",
    last_seen: u.last_seen,
    is_online: !!u.is_online,
    created_at: u.created_at,
    alt_usernames: Array.isArray(u.alt_usernames) ? u.alt_usernames : [],
    birthday: u.birthday || null,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  });
  res.end(body);
}

function getAuth(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : null;
  if (!token) throw Object.assign(new Error("unauthorized"), { status: 401 });
  try {
    const p = verifyToken(token);
    return { userId: p.sub, username: p.username };
  } catch {
    throw Object.assign(new Error("invalid_token"), { status: 401 });
  }
}

function getOrCreateDm(me, otherId) {
  if (me === otherId) throw new Error("self");
  if (!db.users.some((u) => u.id === otherId)) throw new Error("peer_not_found");
  const mine = db.members.filter((m) => m.user_id === me).map((m) => m.conversation_id);
  for (const cid of mine) {
    if (db.members.some((m) => m.conversation_id === cid && m.user_id === otherId)) return cid;
  }
  const id = randomUUID();
  const ts = nowIso();
  db.conversations.push({ id, created_at: ts });
  db.members.push({ conversation_id: id, user_id: me, joined_at: ts });
  db.members.push({ conversation_id: id, user_id: otherId, joined_at: ts });
  save();
  return id;
}

function isMember(convId, userId) {
  return db.members.some((m) => m.conversation_id === convId && m.user_id === userId);
}

/** userId -> Set of sockets {send} */
const socketsByUser = new Map();

function sendToUser(userId, payload) {
  const set = socketsByUser.get(userId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const ws of set) {
    try { ws.send(data); } catch { /* */ }
  }
}
function broadcast(payload, except) {
  for (const [uid, set] of socketsByUser) {
    if (except && uid === except) continue;
    const data = JSON.stringify(payload);
    for (const ws of set) {
      try { ws.send(data); } catch { /* */ }
    }
  }
}


function makeAccept(key) {
  return createHash("sha1")
    .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
}

function encodeWsText(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[0] = 0x81;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeWsFrames(buffer, onMessage) {
  let offset = 0;
  while (offset + 2 <= buffer.length) {
    const b0 = buffer[offset];
    const b1 = buffer[offset + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      if (pos + 2 > buffer.length) break;
      len = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buffer.length) break;
      len = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }
    const maskLen = masked ? 4 : 0;
    if (pos + maskLen + len > buffer.length) break;
    let payload = buffer.subarray(pos + maskLen, pos + maskLen + len);
    if (masked) {
      const mask = buffer.subarray(pos, pos + 4);
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    }
    offset = pos + maskLen + len;
    if (opcode === 0x8) return { closed: true, rest: buffer.subarray(offset) };
    if (opcode === 0x1 || opcode === 0x2) onMessage(payload.toString("utf8"));
  }
  return { closed: false, rest: buffer.subarray(offset) };
}

async function handleHttp(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && pathname === "/health") {
      return sendJson(res, 200, { ok: true, protocol: "Share-Protocol-v1", users: db.users.length, time: nowIso() });
    }

    if (req.method === "POST" && pathname === "/auth/register") {
      const body = await readBody(req);
      const u = String(body.username || "").replace(/^@+/, "").toLowerCase().trim();
      if (!/^[a-z0-9._]{5,32}$/.test(u)) return sendJson(res, 400, { error: "invalid_username" });
      if (!body.password || String(body.password).length < 6) return sendJson(res, 400, { error: "weak_password" });
      if (db.users.some((x) => x.username === u)) return sendJson(res, 409, { error: "username_taken" });
      const user = {
        id: randomUUID(),
        username: u,
        password_hash: hashPassword(String(body.password)),
        display_name: String(body.display_name || u).slice(0, 64),
        avatar_url: body.avatar_url || null,
        bio: "",
        last_seen: nowIso(),
        is_online: false,
        created_at: nowIso(),
      };
      db.users.push(user);
      save();
      return sendJson(res, 200, { token: signToken(user), user: publicUser(user) });
    }

    if (req.method === "POST" && pathname === "/auth/login") {
      const body = await readBody(req);
      const u = String(body.username || "").replace(/^@+/, "").toLowerCase().trim();
      const row = db.users.find((x) => x.username === u);
      if (!row || !verifyPassword(String(body.password || ""), row.password_hash)) {
        return sendJson(res, 401, { error: "invalid_credentials" });
      }
      row.is_online = true;
      row.last_seen = nowIso();
      save();
      return sendJson(res, 200, { token: signToken(row), user: publicUser(row) });
    }

    if (req.method === "GET" && pathname === "/auth/me") {
      const { userId } = getAuth(req);
      const row = db.users.find((x) => x.id === userId);
      if (!row) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { user: publicUser(row) });
    }

    if (req.method === "GET" && pathname === "/profiles") {
      getAuth(req);
      return sendJson(res, 200, { profiles: db.users.map(publicUser) });
    }

    const byUser = pathname.match(/^\/profiles\/by-username\/([^/]+)$/);
    if (req.method === "GET" && byUser) {
      getAuth(req);
      const u = decodeURIComponent(byUser[1]).replace(/^@+/, "").toLowerCase();
      const row = db.users.find(
        (x) =>
          x.username === u ||
          (Array.isArray(x.alt_usernames) && x.alt_usernames.map((a) => String(a).toLowerCase()).includes(u)),
      );
      if (!row) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { profile: publicUser(row) });
    }

    const byId = pathname.match(/^\/profiles\/([^/]+)$/);
    if (req.method === "GET" && byId && byId[1] !== "by-username") {
      getAuth(req);
      const row = db.users.find((x) => x.id === byId[1]);
      if (!row) return sendJson(res, 404, { error: "not_found" });
      return sendJson(res, 200, { profile: publicUser(row) });
    }

    if (req.method === "POST" && pathname === "/presence") {
      const { userId } = getAuth(req);
      const body = await readBody(req);
      const row = db.users.find((x) => x.id === userId);
      if (row) {
        row.is_online = !!body.online;
        row.last_seen = nowIso();
        save();
        broadcast({ type: "presence", userId, online: row.is_online, last_seen: row.last_seen }, userId);
      }
      return sendJson(res, 200, { ok: true });
    }

    const dm = pathname.match(/^\/dm\/([^/]+)$/);
    if (req.method === "POST" && dm) {
      const { userId } = getAuth(req);
      try {
        return sendJson(res, 200, { conversationId: getOrCreateDm(userId, dm[1]) });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }

    const msgs = pathname.match(/^\/conversations\/([^/]+)\/messages$/);
    if (req.method === "GET" && msgs) {
      const { userId } = getAuth(req);
      if (!isMember(msgs[1], userId)) return sendJson(res, 403, { error: "forbidden" });
      const limit = Math.min(Number(url.searchParams.get("limit")) || 80, 200);
      const messages = db.messages
        .filter((m) => m.conversation_id === msgs[1])
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .slice(-limit);
      const ids = new Set(messages.map((m) => m.id));
      const reads = db.reads.filter((r) => ids.has(r.message_id));
      return sendJson(res, 200, { messages, reads });
    }

    if (req.method === "POST" && msgs) {
      const { userId } = getAuth(req);
      if (!isMember(msgs[1], userId)) return sendJson(res, 403, { error: "forbidden" });
      const body = await readBody(req);
      if (!body.ciphertext || !body.iv) return sendJson(res, 400, { error: "missing_payload" });
      const msg = {
        id: randomUUID(),
        conversation_id: msgs[1],
        sender_id: userId,
        ciphertext: body.ciphertext,
        iv: body.iv,
        content_type: ["text", "image", "voice"].includes(body.content_type) ? body.content_type : "text",
        created_at: nowIso(),
      };
      db.messages.push(msg);
      save();
      const members = db.members.filter((m) => m.conversation_id === msgs[1]).map((m) => m.user_id);
      for (const uid of members) sendToUser(uid, { type: "message", message: msg });
      return sendJson(res, 200, { message: msg });
    }

    const readPath = pathname.match(/^\/messages\/([^/]+)\/read$/);
    if (req.method === "POST" && readPath) {
      const { userId } = getAuth(req);
      const msg = db.messages.find((m) => m.id === readPath[1]);
      if (!msg) return sendJson(res, 404, { error: "not_found" });
      if (!isMember(msg.conversation_id, userId)) return sendJson(res, 403, { error: "forbidden" });
      db.reads = db.reads.filter((r) => !(r.message_id === msg.id && r.user_id === userId));
      db.reads.push({ message_id: msg.id, user_id: userId, read_at: nowIso() });
      save();
      sendToUser(msg.sender_id, {
        type: "read",
        message_id: msg.id,
        user_id: userId,
        conversation_id: msg.conversation_id,
      });
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { error: "not_found" });
  } catch (e) {
    const status = e.status || 500;
    return sendJson(res, status, { error: e.message || "error" });
  }
}

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = makeAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  let userId = null;
  let buf = Buffer.alloc(0);
  const ws = {
    send(data) {
      socket.write(encodeWsText(typeof data === "string" ? data : JSON.stringify(data)));
    },
  };

  const onMsg = (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg.type === "auth") {
      try {
        const p = verifyToken(msg.token);
        userId = p.sub;
        if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
        socketsByUser.get(userId).add(ws);
        const row = db.users.find((u) => u.id === userId);
        if (row) {
          row.is_online = true;
          row.last_seen = nowIso();
          save();
        }
        ws.send(JSON.stringify({ type: "auth_ok", userId }));
        broadcast({ type: "presence", userId, online: true, last_seen: nowIso() }, userId);
      } catch {
        ws.send(JSON.stringify({ type: "auth_error" }));
        socket.end();
      }
      return;
    }
    if (!userId) return;
    if (msg.type === "call_signal" && msg.to) {
      sendToUser(msg.to, { type: "call_signal", from: userId, payload: msg.payload });
    }
    if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
  };

  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    const r = decodeWsFrames(buf, onMsg);
    buf = r.rest;
    if (r.closed) socket.end();
  });
  socket.on("close", () => {
    if (!userId) return;
    const set = socketsByUser.get(userId);
    if (set) {
      set.delete(ws);
      if (set.size === 0) {
        socketsByUser.delete(userId);
        const row = db.users.find((u) => u.id === userId);
        if (row) {
          row.is_online = false;
          row.last_seen = nowIso();
          save();
        }
        broadcast({ type: "presence", userId, online: false, last_seen: nowIso() });
      }
    }
  });
  socket.on("error", () => {});
  if (head?.length) {
    buf = Buffer.concat([buf, head]);
  }
});

server.listen(PORT, () => {
  console.log(`Share server  http://localhost:${PORT}`);
  console.log(`WebSocket     ws://localhost:${PORT}/ws`);
});

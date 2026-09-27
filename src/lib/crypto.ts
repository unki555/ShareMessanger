/**
 * AES-256-GCM + кеш ключей.
 * При ошибке расшифровки возвращаем null — UI не спамит «не удалось».
 */

const APP_PEPPER = "share-v1-pepper-change-in-prod-9f3a2c";
const PBKDF2_ITERATIONS = 100_000;
const keyCache = new Map<string, CryptoKey>();

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pairKey(a: string, b: string) {
  return [a.toLowerCase(), b.toLowerCase()].sort().join("|");
}

async function deriveChatKey(userA: string, userB: string): Promise<CryptoKey> {
  const pair = pairKey(userA, userB);
  const hit = keyCache.get(pair);
  if (hit) return hit;
  const material = `${APP_PEPPER}|chat|${pair}`;
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(material),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  const key = await crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(`salt|${pair}|share`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(pair, key);
  return key;
}

export function clearCryptoCache() {
  keyCache.clear();
}

export type EncryptedPayload = { ciphertext: string; iv: string };

export async function encryptText(
  plain: string,
  myUsername: string,
  peerUsername: string,
): Promise<EncryptedPayload> {
  const key = await deriveChatKey(myUsername, peerUsername);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(plain),
  );
  return { ciphertext: b64encode(ct), iv: b64encode(iv) };
}

export async function decryptText(
  ciphertext: string,
  iv: string,
  myUsername: string,
  peerUsername: string,
): Promise<string | null> {
  try {
    if (!ciphertext || !iv) return null;
    const key = await deriveChatKey(myUsername, peerUsername);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64decode(iv) },
      key,
      b64decode(ciphertext),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function encryptImageDataUrl(
  dataUrl: string,
  myUsername: string,
  peerUsername: string,
) {
  return encryptText(dataUrl, myUsername, peerUsername);
}

export async function decryptImageDataUrl(
  ciphertext: string,
  iv: string,
  myUsername: string,
  peerUsername: string,
) {
  return decryptText(ciphertext, iv, myUsername, peerUsername);
}

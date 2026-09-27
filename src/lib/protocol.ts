/**
 * Share Protocol v1 (клиентский E2E-слой)
 *
 * Цели:
 * - plaintext сообщений/медиа не хранится на сервере (только ciphertext + iv)
 * - ключ диалога выводится из пары username (PBKDF2 → AES-256-GCM)
 * - облачный пароль = пароль Auth; локальные метаданные изолированы по user id
 * - медиа (фото/голос) шифруются тем же ключом чата
 *
 * Ограничения: это не Signal (нет forward secrecy / double ratchet).
 * Для production: identity keys + sealed sender + server-side key audit.
 */

export const SHARE_PROTOCOL = {
  version: 1,
  name: "Share-Protocol-v1",
  cipher: "AES-256-GCM",
  kdf: "PBKDF2-SHA256",
  iterations: 100_000,
  ivBytes: 12,
} as const;

export type SecureEnvelope = {
  protocol: typeof SHARE_PROTOCOL.name;
  version: number;
  ciphertext: string;
  iv: string;
  contentType: "text" | "image" | "voice";
};

export function wrapEnvelope(
  ciphertext: string,
  iv: string,
  contentType: SecureEnvelope["contentType"],
): SecureEnvelope {
  return {
    protocol: SHARE_PROTOCOL.name,
    version: SHARE_PROTOCOL.version,
    ciphertext,
    iv,
    contentType,
  };
}

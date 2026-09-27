# SSP — Share Security Protocol v1

Личный протокол мессенджера Share.

## Слои

1. **Транспорт** — HTTPS/WSS (в проде), JWT сессия (HMAC-SHA256).
2. **Учётные данные** — пароль аккаунта (облачный) хэшируется scrypt на сервере; plaintext никогда не пишется на диск.
3. **E2E сообщения / медиа / голос** — AES-256-GCM, ключ PBKDF2 из пары username (клиент).
   Сервер хранит только `ciphertext` + `iv` + `content_type`.
4. **Код-пароль** — только на устройстве (`share_passcode_hash`), серверу не отправляется.
5. **Звонки** — WebRTC (DTLS-SRTP), сигналинг через WS; медиа peer-to-peer.

## Идентификаторы

- Username: `^[a-z0-9._]{5,32}$`
- JWT: 30 дней, secret только на сервере (`JWT_SECRET`)

## Локальная изоляция

Ключи localStorage: `share:{userId}:*` — чаты одного аккаунта не смешиваются с другим.
При регистрации локальные данные устройства очищаются.

## Ограничения v1

Нет double-ratchet / forward secrecy. Для hardened v2: identity keys + sealed sender.

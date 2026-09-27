# Share Server

Свой бэкенд мессенджера Share (вместо Supabase).

## Запуск

```bash
cd server
npm install
npm start
# http://localhost:8787
# ws://localhost:8787/ws
```

## API

- `POST /auth/register` `{ username, password, display_name, avatar_url? }`
- `POST /auth/login` `{ username, password }`
- `GET /auth/me` Bearer
- `GET /profiles`
- `POST /dm/:otherUserId`
- `GET /conversations/:id/messages`
- `POST /conversations/:id/messages` `{ ciphertext, iv, content_type }`
- `POST /messages/:id/read`
- WebSocket `/ws` — auth token, `message`, `read`, `presence`, `call_signal`

Сообщения на диске — только ciphertext (Share Protocol v1 на клиенте).
SQLite: `server/data/share.db`

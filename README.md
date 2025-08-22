# hellohello-musicbot

Bot de Slack que convierte links de canciones (Spotify, Apple Music, YouTube Music) y responde en **thread** con las equivalencias. Funciona **local + ngrok** y en **Vercel**.

## 🚀 Setup local
1) Clona/descarga este repo y entra a la carpeta.
2) Instala dependencias:
```bash
npm install
```
3) Crea `.env.local` a partir de `.env.example` y completa:
```
SLACK_BOT_TOKEN=xoxb-...
SLACK_SIGNING_SECRET=...
ALLOWED_CHANNEL=Cxxxxxxxx   # opcional
```
4) Arranca el server:
```bash
npm run dev
```
5) Proba que el server responde:
- http://localhost:3000/api/ping  → `{ ok: true }`

## 🌐 Probar con ngrok (local)
```bash
ngrok http 3000
``>
Configurá en Slack → **Event Subscriptions → Request URL**:
```
https://TU.ngrok-free.app/api/slack
```
Debe verificarse (challenge OK).

## ☁️ Deploy en Vercel
1) Sube el repo a GitHub.
2) Entra a https://vercel.com → **Add New Project** → conecta tu repo.
3) En **Settings → Environment Variables** agrega:
   - `SLACK_BOT_TOKEN`
   - `SLACK_SIGNING_SECRET`
   - `ALLOWED_CHANNEL` (opcional)
4) Deploy. Tu endpoint será:
```
https://TUAPP.vercel.app/api/slack
```
Pégalo en Slack → **Event Subscriptions → Request URL**.

## 🔐 Scopes y eventos en Slack
- **Bot Token Scopes**: `chat:write`, `channels:history` (y `groups:history` si es canal privado).
- **Bot Events**: `message.channels` (y `message.groups` si privados).
- Instala la app y **/invite** al canal.
- Si usas `ALLOWED_CHANNEL`, usa el **Channel ID** (no el nombre).

## 🧪 Probar
Pega un link de Spotify / Apple Music / YouTube Music en el canal. El bot responde en **thread** con links equivalentes.

## 🛠 Troubleshooting
- 404 en verificación: ruta mal (`/api/slack`) o server no levantado.
- 401/403: `SLACK_SIGNING_SECRET` incorrecto.
- 500: variables faltantes; mira logs.
- Timeout: ya se usa `processBeforeResponse: true` para ack inmediato.

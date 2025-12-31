# juego-mesa-backend
Backend Node/Express + WebSocket con Auth0 y PostgreSQL para progreso de jugador.

## Configuración
1) Variables de entorno (.env):
```
PORT=8080
CLIENT_ORIGIN=http://localhost:5173
AUTH0_DOMAIN=tu-dominio.auth0.com
AUTH0_AUDIENCE=https://tu-api
DATABASE_URL=postgres://user:password@localhost:5432/tu_db
NODE_ENV=development
```

2) Auth0
- Crea una API con Identifier = `AUTH0_AUDIENCE` y algoritmo RS256.
- En Applications > tu SPA, habilita la conexión Google.
- Añade tu origin a Allowed Callback URLs, Allowed Web Origins y CORS.

3) PostgreSQL
- La app crea `users` y `player_progress` al arrancar. Requiere `DATABASE_URL` válido (usa SSL desactivado en local y activado en prod).

## Endpoints protegidos (JWT Bearer)
- GET /me -> crea usuario/progreso si no existe y devuelve `{ user, progress }`.
- PATCH /me/progress -> actualiza campos validados en servidor (level, xp, coins, gems, troops_unlocked[], decks[]).
- POST /me/migrate_guest -> opcional para migrar progreso local usando el mismo esquema.
- GET /health -> libre, para chequeos.

## WebSocket
- Comparte puerto con HTTP (`ws://host:PORT`). Mensajes:
  - `{ "type": "join", "room": "roomId" }`
  - `{ "type": "action", ... }` se retransmite a la sala.

## Notas
- CORS restringido a `CLIENT_ORIGIN` y pensado para HTTPS en producción.
- El middleware JWT valida contra JWKS de Auth0 mediante `express-oauth2-jwt-bearer`.

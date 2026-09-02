# Instalación

## Requisitos
* Node.js ≥ 22 y npm ≥ 10
* PostgreSQL 18 (Docker recomendado) — o el PostgreSQL embebido incluido para desarrollo
* Docker + Docker Compose (despliegue)
* Impresoras Zebra accesibles por TCP 9100 (opcional en desarrollo; ver ZEBRA_SETUP.md)

## Desarrollo local

```bash
cd wms
cp .env.example .env
# genere una clave de cifrado y péguela en APP_ENCRYPTION_KEY
openssl rand -base64 32
npm install

# Base de datos — opción A (Docker):
docker compose up -d db
# Base de datos — opción B (sin Docker, PostgreSQL 18 embebido en ./.pgdata):
npx tsx apps/api/scripts/dev-db.ts &

npm run build -w packages/shared
npm run db:migrate -w apps/api               # aplica migraciones
npm run db:seed -w apps/api                  # roles, permisos, admin
npx tsx apps/api/prisma/seed.ts --demo       # (opcional) almacén de demostración

npm run dev:api                              # http://localhost:4000
npm run dev:web                              # http://localhost:5173
```

Usuarios demo (`--demo`): `supervisor / supervisor-Demo-1!`, `recepcion / recepcion-Demo-1!`, `montacargas / montacargas-Demo-1!`, `surtidor / surtidor-Demo-1!`, `verificador / verificador-Demo-1!`, `cargador / cargador-Demo-1!`, `inventarios / inventarios-Demo-1!`. Administrador: `admin / Admin-Change-Me-1!` (o `SEED_ADMIN_PASSWORD`) — debe inscribir MFA (TOTP) en el primer acceso y cambiar la contraseña.

## Variables de entorno (`.env`)

| Variable | Descripción |
|---|---|
| `DATABASE_URL` / `DATABASE_URL_TEST` | Conexión a PostgreSQL (producción / pruebas) |
| `APP_ENCRYPTION_KEY` | 32 bytes base64; firma cookies y cifra secretos MFA. **Obligatoria** |
| `ALLOWED_ORIGINS` | Orígenes del frontend permitidos (CORS/CSRF), separados por coma |
| `COOKIE_SECURE` | `true` detrás de HTTPS |
| `SESSION_TTL_HOURS` | Duración de sesión (12) |
| `API_PORT`, `API_HOST`, `LOG_LEVEL`, `NODE_ENV` | Servidor |
| `UPLOAD_DIR` | Carpeta de fotos/adjuntos |
| `RATE_LIMIT_MAX`, `LOGIN_RATE_LIMIT_MAX` | Límites por minuto |
| `IDEMPOTENCY_TTL_HOURS` | Retención de claves de idempotencia (48) |
| `INTEGRATION_API_KEY` | Habilita `/api/integrations/*` (SAE) |
| `ERROR_WEBHOOK_URL` | Notificación de errores 500 |
| `SEED_ADMIN_PASSWORD` | Contraseña inicial del admin al sembrar |

## Verificación
```bash
curl -s localhost:4000/api/health/ready       # {"status":"ok","db":"ok"}
npm run test:unit
npm run test:integration -w apps/api
```

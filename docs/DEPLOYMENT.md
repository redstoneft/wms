# Despliegue

## Docker Compose (recomendado para un servidor)

```bash
cd wms
cp .env.example .env            # editar: POSTGRES_PASSWORD, APP_ENCRYPTION_KEY, ALLOWED_ORIGINS, COOKIE_SECURE=true
docker compose build
docker compose up -d
docker compose logs -f api      # "[entrypoint] applying migrations" → "WMS API listening"
```

Servicios: `db` (PostgreSQL 18, volumen `wms_pgdata`), `api` (Fastify, puerto 4000, aplica migraciones y seed base al arrancar, volumen `wms_uploads`), `web` (nginx sirviendo la SPA y proxy `/api` → `api:4000`, puerto 8080), `backup` (pg_dump periódico a `./backups`).

Ponga un proxy HTTPS delante de `web` (Caddy/nginx/Traefik) y ajuste `ALLOWED_ORIGINS=https://wms.suempresa.com` y `COOKIE_SECURE=true`.

### Primer arranque
1. `docker compose up -d`
2. Entrar como `admin` (contraseña `SEED_ADMIN_PASSWORD` o la por defecto) → inscribir MFA → cambiar contraseña.
3. Crear usuarios reales por rol. **No** ejecutar el seed `--demo` en producción.
4. Configurar impresoras (`/admin` → Impresoras) y el layout (WAREHOUSE_SETUP.md) o importarlo desde plantillas CSV.
5. Cargar inventario inicial (plantilla `INITIAL_INVENTORY`) tras un conteo físico.

### Actualizaciones
```bash
git pull
docker compose build api web
docker compose up -d api web     # las migraciones se aplican solas; el ledger nunca se modifica
```
Antes de actualizar en producción: `scripts/backup.sh` y comprobar `GET /api/inventory/reconcile`.

## Instalación real (2 de septiembre de 2026)

| Elemento | Valor |
|---|---|
| URL | `https://wms.104-248-116-147.sslip.io` (DNS automático de sslip.io hacia la IP del servidor; se puede cambiar por un dominio propio repitiendo el paso de certbot) |
| Servidor | ClawCloud `104.248.116.147` (Ubuntu 24.04, 2 vCPU, 2 GB + 2 GB swap), usuario `openclaw`, código en `~/wms` |
| Contenedores | `docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d` → `wms-db`, `wms-api`, `wms-web` (solo `127.0.0.1:8081`), `wms-backup` (dumps en `~/wms/backups`) |
| TLS | nginx del sistema (`/etc/nginx/sites-enabled/wms`) con certificado Let's Encrypt (certbot, renovación automática), proxy a `127.0.0.1:8081` |
| Secretos | `~/wms/.env.production` (chmod 600, fuera de git): contraseña de PostgreSQL, `APP_ENCRYPTION_KEY`, `SEED_ADMIN_PASSWORD`, `INTEGRATION_API_KEY`, claves SAE |
| Actualizar | `rsync` del repo a `~/wms` (excluyendo `node_modules`, `.env*`, `dist`) → `docker compose … up -d --build api web` → verificar `/api/health/ready` y `/api/inventory/reconcile` |

`docker-compose.prod.yml` quita los puertos publicados de `db` y `api` y deja `web` solo en localhost: nada del WMS es accesible sin pasar por el nginx con TLS.

## Sin Docker (systemd)
```bash
npm ci && npm run build
cd apps/api && npx prisma migrate deploy && npx tsx prisma/seed.ts
NODE_ENV=production node dist/server.js
```
Sirva `apps/web/dist` con nginx (config de referencia en `apps/web/nginx.conf`).

## Salud y monitoreo
* `GET /api/health/live` — proceso vivo. `GET /api/health/ready` — BD accesible (503 si no).
* `GET /api/metrics` (permiso `dashboard.read`) — formato Prometheus: movimientos, LPNs por estado, pedidos por estado, incidencias abiertas, uptime, memoria.
* Logs JSON (pino) en stdout con `request_id`; `LOG_LEVEL=info` en producción.
* `ERROR_WEBHOOK_URL` para recibir cada 500 en Slack/Discord.
* Alertas operativas en el dashboard (`GET /api/dashboard.alerts`): incidencias críticas, pallets > 4 h sin ubicar, embarques bloqueados, ocupación > 90 %.

## Escalado
* La API es stateless: varias réplicas detrás del proxy funcionan; las tareas de fondo son idempotentes (bloqueos en BD). El rate limiting es por réplica (ver riesgos residuales en SECURITY.md).
* PostgreSQL: `shared_buffers` 25 % de RAM, `max_connections` ≥ 50 × réplicas de API. Índices ya cubren ledger por SKU/LPN/pedido/fecha.
* Adjuntos: montar `UPLOAD_DIR` en almacenamiento compartido si hay varias réplicas.

## Backups
Ver BACKUPS.md y RESTORE.md. El servicio `backup` del compose se encarga del respaldo periódico; copie `./backups` fuera del servidor.

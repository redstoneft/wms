# WMS — Warehouse Management System

Sistema de gestión de almacén para operación física real: recepción de contenedores, LPN, put-away dirigido con slotting, inventario por ledger, reabasto, conteos ciegos, pedidos, reserva, picking dirigido, staging, doble validación, carga con regla absoluta de liberación por SKU, devoluciones, incidencias, RBAC + MFA, auditoría inmutable, etiquetas Zebra ZPL y **gemelo digital 3D** del almacén.

**Prioridad absoluta: integridad del inventario + trazabilidad + prevención de errores.**

## Arranque rápido

```bash
cp .env.example .env         # poner APP_ENCRYPTION_KEY (openssl rand -base64 32)
npm install
docker compose up -d db                # o: npx tsx apps/api/scripts/dev-db.ts (PostgreSQL 18 embebido)
npm run build -w packages/shared
npm run db:migrate -w apps/api && npm run db:seed -w apps/api
npx tsx apps/api/prisma/seed.ts --demo # almacén de demostración (solo desarrollo)
npm run dev:api                        # http://localhost:4000
npm run dev:web                        # http://localhost:5173
```

Producción: `docker compose up -d` (ver [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)).

## Documentación

| Documento | Contenido |
|---|---|
| [INSTALLATION](docs/INSTALLATION.md) | Requisitos, instalación, variables de entorno |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Diseño, ledger, concurrencia, regla de liberación, decisiones |
| [DATABASE](docs/DATABASE.md) | Esquema, triggers, funciones, reconstrucción |
| [SECURITY](docs/SECURITY.md) | Autenticación, RBAC, CSRF, auditoría, riesgos residuales |
| [BACKUPS](docs/BACKUPS.md) · [RESTORE](docs/RESTORE.md) | Respaldos, retención, DR y simulacro de restore probado |
| [DEPLOYMENT](docs/DEPLOYMENT.md) | Docker Compose, systemd, monitoreo, escalado |
| [WAREHOUSE_SETUP](docs/WAREHOUSE_SETUP.md) | Configurar almacén, zonas, racks, ubicaciones, maestros |
| [ZEBRA_SETUP](docs/ZEBRA_SETUP.md) | Impresoras, etiquetas, reimpresión |
| [INTEGRATION_SAE](docs/INTEGRATION_SAE.md) | Sincronización Aspel SAE → WMS (artículos, clientes, proveedores, OC, pedidos, existencias) |
| [USER_GUIDE](docs/USER_GUIDE.md) · [ADMIN_GUIDE](docs/ADMIN_GUIDE.md) | Uso en oficina y administración |
| [MANUAL_OPERACION](docs/MANUAL_OPERACION.md) | Manual para personal de piso (recepción, put-away, picking, verificación, carga, conteos, incidencias) |
| [MANUAL_ETIQUETADO_RACKS](docs/MANUAL_ETIQUETADO_RACKS.md) | Manual para quien pega las etiquetas de ubicación en los racks (orden, dónde va cada una, verificación con escáner, hoja de control) |
| [TESTING](docs/TESTING.md) | Suites, cómo ejecutarlas, bugs encontrados |
| [REQUIREMENTS_MATRIX](docs/REQUIREMENTS_MATRIX.md) | Requerimiento → implementación → prueba |
| [TROUBLESHOOTING](docs/TROUBLESHOOTING.md) | Errores frecuentes y diagnóstico |
| [PRODUCTION_READINESS](docs/PRODUCTION_READINESS.md) | Evidencia de la lista de terminación y estado honesto |

## Estructura

```
wms/
├── apps/api        Fastify + Prisma + PostgreSQL (módulos por dominio, ledger de inventario)
├── apps/web        React + Vite + Tailwind + React Three Fiber (modo oficina, modo almacén, mapa 3D)
├── packages/shared enums, esquemas zod, UoM, regla de liberación, ZPL
├── docs/           documentación
├── scripts/        backup/restore, init de BD
└── docker-compose.yml
```

## Pruebas

```bash
npm run test:unit                       # shared + api
npm run test:integration -w apps/api    # integración, concurrencia, seguridad, fuzz, red
npm run test:e2e -w apps/web            # Playwright
SCALE=0.1 npm run test:load -w apps/api # carga
npx tsx apps/api/scripts/backup-restore-test.ts
```

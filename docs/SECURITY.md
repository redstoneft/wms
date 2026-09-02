# Seguridad

## Autenticación
* Contraseñas con **scrypt** (N=2¹⁵, r=8, p=1, sal aleatoria de 16 bytes, NFKC). Mínimo 12 caracteres.
* Sesiones opacas: token aleatorio de 32 bytes, almacenado como SHA-256 en `sessions`; cookie `wms_session` **firmada**, `HttpOnly`, `SameSite=Strict`, `Secure` cuando `COOKIE_SECURE=true`. Expiración (`SESSION_TTL_HOURS`, 12 h por defecto) y revocación en logout, cambio de contraseña, desactivación de usuario y reseteo de MFA.
* Bloqueo de cuenta: 10 fallos → 15 minutos (`423 ACCOUNT_LOCKED`). Respuestas idénticas para usuario inexistente y contraseña incorrecta; verificación contra un hash dummy para igualar tiempos.
* **MFA TOTP (RFC 6238)** obligatorio para `ADMIN`: hasta completar la inscripción/verificación la sesión no tiene ningún permiso (`403 MFA_REQUIRED`). El secreto se guarda cifrado con AES-256-GCM (`APP_ENCRYPTION_KEY`).
* Rate limiting global (600 req/min por usuario/IP) y específico para login y verificación MFA (10/min).

## Autorización
* RBAC con ~50 permisos granulares (`packages/shared/src/permissions.ts`) evaluados en el backend en cada ruta (`requirePermission`). El frontend solo oculta opciones.
* Separación de funciones: operadores no pueden liberar embarques, aprobar conteos, ajustar inventario ni autorizar excepciones. `PICKER` y `VERIFIER` son roles distintos; el mismo usuario no puede verificar su propio surtido sin autorización `SAME_USER_VERIFICATION` registrada.
* Autorizaciones de supervisor por excepción (`authorizations`): una sola aprobación posible por (excepción, entidad); se consumen atómicamente con la operación y quedan en auditoría.
* Propiedad de tareas: un picker no puede escanear la tarea de otro (`409 NOT_YOUR_TASK`).

## Protección de la API
* **CSRF**: cabecera obligatoria `X-Requested-With: wms-client` en toda mutación (fuerza preflight CORS) + verificación de `Origin`/`Referer` contra `ALLOWED_ORIGINS` + cookie `SameSite=Strict`.
* **CORS** restringido a `ALLOWED_ORIGINS` con credenciales.
* **Cabeceras** vía `@fastify/helmet` (CSP la fija nginx en el frontend).
* **Validación** de todo input con zod (cuerpos, query, params); cantidades solo enteros positivos con límite superior; códigos/barcodes con alfabeto restringido; bytes NUL rechazados (hallazgo de fuzzing). Body máximo 5 MB; uploads 20 MB con validación de MIME **y** magic bytes; los archivos se guardan con nombre content-addressed, nunca con el nombre original.
* **SQL**: Prisma parametriza todo; el SQL crudo usa exclusivamente parámetros (`$queryRaw` con template tags). Los tests de seguridad ejecutan cargas de inyección clásicas en búsquedas, barcodes y códigos LPN.
* Errores estructurados `{ error, message, details, request_id }`; nunca stack traces (el campo `debug` solo existe fuera de producción).
* Logs con pino y redacción de `cookie`, `authorization`, `set-cookie`, `password*`, `token`, `secret`, `mfa_secret_enc`. La auditoría pasa por `scrub()` que enmascara claves que parezcan secretos.

## Auditoría
`audit_logs` append-only (trigger): quién (`user_id`, `username`), qué (`action`), cuándo, dónde (`ip`, `device_id`, `request_id`), antes/después (JSON) y por qué (`reason`). Cubre autenticación (incluidos fallos), cambios de maestros, layout, todas las operaciones de almacén, autorizaciones, reimpresiones y escaneos bloqueados (útil para KPIs de errores por usuario).

## Secretos
* Fuera del repositorio: `.env` (ignorado). Plantilla en `.env.example`.
* `APP_ENCRYPTION_KEY`: 32 bytes aleatorios en base64 (`openssl rand -base64 32`). Rotarla requiere re-cifrar `users.mfa_secret_enc` (o resetear MFA a los usuarios).
* Contraseñas iniciales de seed: el admin debe cambiarla al primer acceso; los usuarios demo solo existen con `--demo`.

## Pruebas de seguridad incluidas
`apps/api/test/security/security.test.ts`: acceso anónimo, bloqueo por fuerza bruta, cookies alteradas, revocación al logout, MFA obligatorio para admin, CSRF (cabecera y Origin), IDOR sobre tareas, escalada de privilegios (crear admin, autoasignarse autorizaciones, cambiar settings), auto-desactivación, inyección SQL en búsquedas y escaneos, cantidades inválidas, JSON inválido/oversize, importaciones maliciosas (fórmulas, inyección, duplicados), subida de archivos no permitidos/falsos, ausencia de secretos en auditoría, ausencia de stack traces.

## Riesgos residuales (documentados, no resueltos)
1. **TLS** no lo termina la API: debe desplegarse detrás de un proxy HTTPS (nginx/Caddy) con `COOKIE_SECURE=true`.
2. **Rate limiting en memoria**: por instancia. Con varias réplicas conviene el store Redis de `@fastify/rate-limit` o limitar en el proxy.
3. **MFA solo para ADMIN** (configurable por usuario para otros roles, pero no obligatorio). Los operadores de piso usan contraseña; recomendable política de rotación y terminales gestionadas.
4. **Impresoras Zebra por TCP 9100 sin autenticación** (limitación del protocolo): la red de impresoras debe estar segmentada.
5. **Recuperación de contraseña** es administrativa (reset por `users.manage`), no hay flujo por correo.
6. Sin firma/antivirus de adjuntos: se validan tipo y magic bytes, pero un PDF malicioso no se analiza; los adjuntos se sirven por fuera del navegador de operación.
7. `npm audit` se ejecuta en CI a nivel `high` como advertencia; deben revisarse periódicamente las dependencias.

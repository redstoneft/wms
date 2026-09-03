# Seguridad

## Dispositivos de confianza (MFA recordado)
Al verificar el código TOTP el usuario puede marcar **"Recordar este dispositivo"**: el navegador recibe una segunda cookie (`wms_trusted`, firmada, HttpOnly, Secure, SameSite=Strict) con un token opaco de 32 bytes cuyo hash se guarda en `trusted_devices` junto con dispositivo, agente e IP. En los siguientes inicios de sesión ese token, si pertenece al mismo usuario, no está revocado ni vencido, satisface el segundo factor; la sesión queda `mfa_verified` y la auditoría registra `mfa_via_trusted_device`. Vigencia: `mfa_trusted_device_days` (30 por defecto, 0 desactiva la opción). El usuario ve y revoca sus dispositivos en *Mi cuenta*; un cambio de contraseña o un reset de MFA por el administrador revoca todos. La contraseña sigue siendo obligatoria en cada inicio de sesión: lo recordado es solo el segundo factor.

## Autenticación
* Contraseñas con **scrypt** (N=2¹⁵, r=8, p=1, sal aleatoria de 16 bytes, NFKC). Mínimo 12 caracteres.
* Sesiones opacas: token aleatorio de 32 bytes, almacenado como SHA-256 en `sessions`; cookie `wms_session` **firmada**, `HttpOnly`, `SameSite=Strict`, `Secure` cuando `COOKIE_SECURE=true`. Expiración (`SESSION_TTL_HOURS`, 12 h por defecto) y revocación en logout, cambio de contraseña, desactivación de usuario y reseteo de MFA.
* Bloqueo de cuenta: 10 fallos → 15 minutos (`423 ACCOUNT_LOCKED`). Respuestas idénticas para usuario inexistente y contraseña incorrecta; verificación contra un hash dummy para igualar tiempos.
* **MFA TOTP (RFC 6238)** obligatorio para `ADMIN`: hasta completar la inscripción/verificación la sesión no tiene ningún permiso (`403 MFA_REQUIRED`). El secreto se guarda cifrado con AES-256-GCM (`APP_ENCRYPTION_KEY`).
* Rate limiting global (2,000 req/min por IP — varios handhelds pueden compartir NAT) y específico para login y verificación MFA (10/min). **Los códigos MFA fallidos cuentan como intentos de login**: 10 fallos bloquean la cuenta y revocan sus sesiones.
* `TRUST_PROXY=false` por defecto: la IP registrada en sesiones/auditoría es la real del socket; `X-Forwarded-For` solo se honra si se configura la lista de proxies. Los `request_id` los genera siempre el servidor (no se aceptan del cliente).

## Autorización
* RBAC con ~50 permisos granulares (`packages/shared/src/permissions.ts`) evaluados en el backend en cada ruta (`requirePermission`). El frontend solo oculta opciones.
* Separación de funciones: operadores no pueden liberar embarques, aprobar conteos, ajustar inventario ni autorizar excepciones. `PICKER` y `VERIFIER` son roles distintos; el mismo usuario no puede verificar su propio surtido sin autorización `SAME_USER_VERIFICATION` registrada.
* Autorizaciones de supervisor por excepción (`authorizations`): una sola aprobación posible por (excepción, entidad); se consumen atómicamente con la operación y quedan en auditoría. **Separación de funciones obligatoria**: el supervisor que autoriza no puede ser quien ejecuta la excepción ni el surtidor del pedido (`SELF_AUTHORIZATION`), no puede autorizar solicitudes propias, el tipo de excepción se valida contra la lista cerrada y `FORCE_RELEASE_NOT_ALLOWED` se rechaza siempre.
* **Intentos bloqueados son trazables**: un escaneo rechazado (ubicación/SKU/cantidad incorrectos, pallet en embarque equivocado, liberación bloqueada) hace rollback de la operación pero persiste su auditoría/incidencia/estado en una transacción posterior (`RuleError.persistAfterRollback`). Los KPIs de errores por usuario y precisión de carga se alimentan de ahí.
* La identidad de integración (`integration`, API key) no tiene roles, tiene contraseña aleatoria y bloqueo permanente: la API key nunca se convierte en un login interactivo.
* Propiedad de tareas: un picker no puede escanear la tarea de otro (`409 NOT_YOUR_TASK`).

## Protección de la API
* **CSRF**: cabecera obligatoria `X-Requested-With: wms-client` en toda mutación (fuerza preflight CORS) + verificación de `Origin`/`Referer` contra `ALLOWED_ORIGINS` + cookie `SameSite=Strict`.
* **CORS** restringido a `ALLOWED_ORIGINS` con credenciales.
* **Cabeceras** vía `@fastify/helmet` (CSP la fija nginx en el frontend).
* **Validación** de todo input con zod (cuerpos, query, params); cantidades solo enteros positivos con límite superior; códigos/barcodes con alfabeto restringido; bytes NUL rechazados (hallazgo de fuzzing). Body máximo 5 MB; uploads 20 MB con validación de MIME **y** magic bytes; los archivos se guardan con nombre content-addressed, nunca con el nombre original.
* **SQL**: Prisma parametriza todo; el SQL crudo usa exclusivamente parámetros (`$queryRaw` con template tags). Los tests de seguridad ejecutan cargas de inyección clásicas en búsquedas, barcodes y códigos LPN.
* **Idempotencia obligatoria**: los 13 endpoints que producen movimientos rechazan con `400 IDEMPOTENCY_KEY_REQUIRED` cualquier petición sin `Idempotency-Key`; un reintento nunca puede duplicar un escaneo.
* **Defensa en profundidad en BD**: `inventory_balances` y `lpns.current_location_id` solo pueden cambiar desde el trigger del ledger (`P0005` en cualquier escritura directa); el trigger valida además que el origen de cada movimiento coincida con la ubicación real del LPN.
* Hosts de impresoras limitados a IPv4 privadas o nombres de LAN (el API no puede usarse como relay TCP). Mensajes crudos de PostgreSQL solo se exponen fuera de producción.
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
2. **Rate limiting en memoria**: por instancia y por IP (el actor aún no existe en `onRequest`). Con varias réplicas conviene el store Redis de `@fastify/rate-limit` o limitar en el proxy. Detrás de un proxy es imprescindible configurar `TRUST_PROXY` con la IP del proxy, si no todos los clientes comparten el límite.
3. **MFA solo para ADMIN** (configurable por usuario para otros roles, pero no obligatorio). Los operadores de piso usan contraseña; recomendable política de rotación y terminales gestionadas.
4. **Impresoras Zebra por TCP 9100 sin autenticación** (limitación del protocolo): la red de impresoras debe estar segmentada.
5. **Recuperación de contraseña** es administrativa (reset por `users.manage`), no hay flujo por correo.
6. Sin firma/antivirus de adjuntos: se validan tipo y magic bytes, pero un PDF malicioso no se analiza; los adjuntos se sirven por fuera del navegador de operación.
7. `npm audit` se ejecuta en CI a nivel `high` como advertencia; deben revisarse periódicamente las dependencias.

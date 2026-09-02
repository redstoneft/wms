# WMS · Web (`apps/web`)

React 19 SPA for the warehouse management system: office mode (tables, filters, detail drawers), warehouse mode for Zebra/RF handhelds (`/wm/*`) and an interactive 3D digital twin of the warehouse (`/map`). UI language is Spanish (MX); code and comments are in English.

## Run

```bash
# from the monorepo root
npm install
npm run build -w packages/shared        # @wms/shared (enums, zod schemas, UomTable, evaluateRelease, renderZpl)
(cd apps/api && npx tsx src/server.ts)  # API on :4000 (needs local PostgreSQL, see apps/api/.env)
npm run dev -w apps/web                 # Vite on http://localhost:5173 (proxies /api → :4000)
```

Demo users: `supervisor / supervisor-Demo-1!`, `recepcion`, `montacargas`, `surtidor`, `surtidor2`, `verificador`, `cargador`, `inventarios` (same password pattern) and `admin / Admin-Change-Me-1!` (enrolls TOTP MFA on first login: QR + secret, then 6-digit code).

```bash
npm run typecheck -w apps/web   # tsc -b --noEmit
npm run build -w apps/web       # tsc -b && vite build → dist/
npm run test:e2e -w apps/web    # Playwright (starts Vite itself; API must be running on :4000)
npx playwright install chromium # once
```

Production image: `docker build -f apps/web/Dockerfile -t wms-web .` (build context = repo root). nginx serves the SPA with history fallback, proxies `/api` to `http://api:4000`, and sets CSP / `X-Frame-Options: DENY` / nosniff / referrer / permissions headers (`nginx.conf`).

## Structure

```
src/
  api/         client.ts (fetch wrapper) + one typed module per API area (auth, layout, masterdata, inbound,
               inventory, storage, orders, shipments, incidents, returns, labels, imports, dashboard, admin) + types.ts
  auth/        AuthContext (session, permissions, MFA pending)
  components/  ui/ (Button, Table, Drawer, Modal, ConfirmDialog, StatusChip, Tabs…), ScanInput, QtyPad, UomQty,
               LabelPreview, Timeline, Toast, OfflineBanner, ErrorBoundary
  layout/      AppShell (sidebar / bottom nav / top bar) + nav.ts (routes ↔ permissions)
  lib/         feedback.ts (WebAudio beeps + vibrate), format.ts (bigint qty, dates, ES labels), device.ts, online.ts, hooks.ts
  map/         mapModel.ts (payload → instances), MapScene.tsx (R3F scene), MapPage.tsx (filters/search/panels)
  pages/       office screens (dashboard, inbound, inventory, storage, orders, picking, shipments, incidents,
               returns, labels, imports, layout, masterdata, timeline, admin/*)
  wm/          warehouse-mode shell + flows (receive, putaway, transfer, replenish, count, pick, stage, verify, load)
e2e/           Playwright specs (auth+dashboard, receive scan, put-away wrong location, 3D map search)
```

## Design decisions

- **API client** (`src/api/client.ts`): same-origin `/api` with `credentials: 'include'`; `X-Requested-With: wms-client` on every mutation (CSRF guard); `X-Device-Id` (UUID persisted in localStorage) on every request. Movement-producing POSTs go through `api.postIdem(path, body, key)` with an `Idempotency-Key` generated **once per user action** (`api.newKey()`); only keyed requests (and GETs) are retried on network errors/timeouts, max 3 attempts with 0.5/1.5/3 s backoff. `Idempotent-Replayed: true` is surfaced as `replayed` and shown as success ("YA REGISTRADO"). Errors are `ApiError {status, code, message, details, requestId}`; 401 clears the session → `/login`; 403 with `details.code === 'MFA_REQUIRED'` → `/mfa`.
- **Offline**: `lib/online.ts` combines `navigator.onLine` with failed-fetch detection; red banner in both modes.
- **Quantities** are never floats: JSON strings → `BigInt` (`lib/format.ts`), UoM breakdown via `UomTable` from `@wms/shared` ("1 PALLET + 2 CASE + 3 PIECE").
- **Permissions** only hide navigation/buttons (`useAuth().can`); the API enforces them. Route guards render a "Sin permiso" panel.
- **Data fetching**: TanStack Query; dashboard refetches every 15 s, map every 10 s, operational lists every 10–15 s. API 4xx/5xx are not retried by React Query (only network errors).
- **Forms**: controlled inputs; the API's zod schemas are the source of truth (400 details are shown as toast text).
- No UI library dependency: a small Tailwind-based kit in `components/ui`. Only `qrcode` (MFA QR) was added to `package.json`.
- Barcode → SKU resolution before the quantity step uses a client-side map of the SKU catalogue (see `API_GAPS.md` #1).

## Warehouse-mode UX rules (`/wm/*`, `src/wm/WmShell.tsx`)

- Full-screen dark, high-contrast layout; every action button ≥ 64 px tall (`BigButton`), values shown huge (`BigValue`).
- A `StepBar` always tells the operator exactly what to scan next ("2 · ESCANEA LA UBICACIÓN").
- `ScanInput` keeps focus (refocus on blur, route change, after every action, plus a 800 ms safety net that never steals focus from another input/button), handles Enter/Tab from keyboard-wedge scanners, ignores an identical scan within 400 ms (double-scan guard) and shows "LISTO PARA ESCANEAR / PROCESANDO".
- Feedback: short high beep + green 300 ms flash on success; two long low beeps + red flash on error; `navigator.vibrate` when available (`lib/feedback.ts`, WebAudio, no assets).
- Every error (422 business rule, 409 conflict, 403, network) is a **blocking full-screen red banner** with the API message, expected/scanned details and a huge OK button. Nothing can be "marked complete" manually; completion only happens through the API state machine.
- Exceptions require a supervisor: put-away to a different location (`PUTAWAY_LOCATION_OVERRIDE`), verifier = picker (`SAME_USER_VERIFICATION`), order cancel during picking, inventory adjustments. The handheld shows the entity id to give to the supervisor and accepts the `authorization_id` created in `/admin/authorizations`.
- Quantities are entered on a big keypad with UoM buttons (PALLET/CASE/INNER/PIECE) taken from the SKU; the base-unit conversion is shown live.

## 3D digital twin (`/map`)

- Data: `GET /api/map` (refetched every 10 s + manual refresh + "last updated"). `mapModel.ts` converts the payload to render-ready instances. Coordinates: API `x` (width) → Three `x`, API `y` (depth) → Three `z`, API `z` (height) → Three `y`. Rack slots use **center** semantics; area locations (docks, staging, shipping, quarantine, returns) use **corner** semantics (as seeded).
- Rendering (`MapScene.tsx`, react-three-fiber + drei): floor plane + grid + wall outline; zones as translucent coloured planes with HTML labels; rack frames as **two InstancedMeshes** (uprights, beams) built from rack geometry (bays × bay_width, levels × level_height, rotation); every rack position as one instance of a translucent **InstancedMesh** coloured via `instanceColor` by status (FREE grey, PARTIAL yellow, OCCUPIED blue, RESERVED purple, BLOCKED red, QUARANTINE orange); pallets as InstancedMeshes (brown base + cardboard load, load height scaled by fill). Area pallets are laid out in a grid inside the area footprint (up to 3 layers).
- **LOD**: when the camera is farther than 55 m from the warehouse centre, detailed pallets are swapped for a single flat-coloured InstancedMesh and rack labels are hidden. `frameloop="demand"` + `invalidate()` on data/selection changes; `dpr=[1,1.5]`; `frustumCulled` off for instanced meshes (bounding spheres recomputed). Labels only for zones, racks and areas (never per slot).
- Interaction: OrbitControls; hover tooltip (code, status, LPN count, qty); click → side panel with `GET /api/locations/:id` (type, capacity, occupancy, LPNs and contents, weight, last movement); Esc clears. Search box: SKU → highlights (pulsing emissive boxes) every location holding it + hit list (+ optional "Filtrar"); LPN / LOCATION → camera fly (1 s eased lerp of position and target) + highlight; ORDER → highlights staging lane and allocated pallets. Filters: zone, type, status, availability (hidden instances get a zero-scale matrix so buffer sizes stay constant). Occupancy panel: warehouse, per zone (click to filter), per rack.
- **Modo edición** (`layout.manage`): click a rack frame → form x/y/rotation → `PATCH /racks/:id` → map refetch.

## Routes and required permissions

| Route | Permission (any of) |
|---|---|
| `/login`, `/mfa` | — |
| `/` Tablero + KPIs | dashboard.read |
| `/map` Mapa 3D | layout.read (edit: layout.manage) |
| `/layout` | layout.read (edit: layout.manage) |
| `/masterdata` | masterdata.read (edit: masterdata.manage, printers.manage, settings.manage for reasons) |
| `/imports` | imports.run |
| `/inbound/containers`, `/inbound/containers/:id` | containers.read (manage: containers.manage) |
| `/inbound/receipts`, `/inbound/receipts/:id` | receiving.read (scan/complete: receiving.scan; close: receiving.close) |
| `/inventory`, `/inventory/lpn/:code` | inventory.read (adjust: inventory.adjust; quarantine: inventory.quarantine) |
| `/storage` (put-away, traslados, reabasto, conteos) | putaway.execute / transfers.execute / replenishment.execute / counts.manage / counts.execute |
| `/orders`, `/orders/:id` | orders.read (manage/allocate/picking.assign for actions) |
| `/picking` | picking.assign / picking.execute |
| `/shipments`, `/shipments/:id` | shipments.read (manage / release / loading.execute for actions) |
| `/incidents`, `/incidents/:id` | incidents.read (create / resolve) |
| `/returns`, `/returns/:id` | returns.manage / orders.read |
| `/labels` | labels.print (reprint needs labels.reprint) |
| `/timeline`, `/timeline/:lpn` | inventory.read / lpn.read |
| `/account` | — |
| `/admin/users` | users.manage |
| `/admin/settings` | settings.manage |
| `/admin/authorizations` | exceptions.authorize |
| `/admin/audit` | audit.read |
| `/admin/slotting` | layout.read (edit: settings.manage) |
| `/wm` | — (shows only the flows the role can run) |
| `/wm/receive` | receiving.scan |
| `/wm/putaway` | putaway.execute |
| `/wm/transfer` | transfers.execute |
| `/wm/replenish` | replenishment.execute |
| `/wm/count` | counts.execute |
| `/wm/pick`, `/wm/stage` | picking.execute |
| `/wm/verify` | verification.execute |
| `/wm/load` | loading.execute |

## Tests

`e2e/` (Playwright, Chromium, `webServer` starts Vite; API on :4000 must be running with the seeded demo data):

- `auth.spec.ts` — invalid login error, login + dashboard cards/KPIs, protected route redirect.
- `receive.spec.ts` — creates a receipt through the API, scans barcode `7501000000001` and qty 12 on `/wm/receive`, asserts the LPN exists via API, closes it and asserts a put-away task; unknown barcode shows the blocking error banner.
- `putaway.spec.ts` — receives+closes a pallet via API, scans it on `/wm/putaway`, scans a wrong location → "UBICACIÓN INCORRECTA" banner + override panel; scans the right one → LPN STORED at target.
- `map.spec.ts` — canvas, legend and occupancy render; SKU search lists hits and highlights; clicking a hit opens the location panel; Esc clears; LPN not found warning.
- `smoke.spec.ts` — every office route and every warehouse-mode route renders (h1 present, no error boundary, no page errors) as supervisor; an operator without permission sees "Sin permiso" and no admin navigation.

Sessions are created once per user through the API and injected as the `wms_session` cookie (the login route is rate-limited to 10/min per IP).

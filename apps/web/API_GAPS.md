# API gaps found while building `apps/web`

The API was not modified. These are endpoints the UI needed and had to work around, or responses that were awkward to consume.

| # | Method / path (proposed) | Purpose | Workaround in the UI |
|---|---|---|---|
| 1 | `GET /api/skus/by-barcode/:barcode` | Resolve a scanned barcode to SKU + UoM **before** capturing the quantity (receiving, counts, verification need the SKU's UoM table to offer PALLET/CASE/PIECE buttons and to show the description). `resolveSkuBarcode` exists server-side but is only reachable through mutating scan endpoints. | `WmReceivePage` loads `GET /skus?limit=500&active=true` once and builds a barcode → SKU map client-side. Works for the demo catalogue; will not scale past 500 SKUs. Count/verify pads fall back to PIECE-only when the SKU is unknown. |
| 2 | `GET /api/attachments/:id` (file download) | Show container / incident photos. `POST …/photos` stores files and returns metadata, but nothing serves the bytes. | Photo lists show file name, size and date only. |
| 3 | `GET /api/putaway/tasks?mine=true` and `assigned_to` filter | Handheld "my tasks" list for put-away. | The handheld shows all active tasks (first 30). |
| 4 | `GET /api/orders` accepting `shipment_id` / `unassigned=true` | Pick orders eligible for a shipment. | Fetch by status list and filter `shipment_id == null` client-side. |
| 5 | `GET /api/verifications/pending-orders` does not return `verification_id` of an IN_PROGRESS verification | Resume an interrupted verification from the handheld. | Operator must restart the flow; the API rejects a second start with 409 `VERIFICATION_IN_PROGRESS`, so the UI can only show the error. |
| 6 | `GET /api/map` — `zones[].x_m/width_m…` come as **strings** (Prisma Decimal) while `locations[]` coordinates come as `float8` numbers and `racks[]` are pre-converted | Mixed numeric encodings in one payload. | `Number()` on zone/warehouse fields in `mapModel.ts`. |
| 7 | `GET /api/locations/:idOrCode` — `x_m, y_m …` returned as strings and `lpns[].contents` as JSON aggregate | Fine, but `pick_sequence`/`restrictions` need an explicit contract for the layout editor. | Typed loosely (`Record<string, unknown>` for restrictions). |
| 8 | `GET /api/incidents?order_id=`/`?shipment_id=`/`?lpn_id=` filters | Show incidents on order / shipment / LPN detail pages. | Only `entity_type`+`entity_id` filters exist; receipt detail uses them. Order/shipment pages link to the incidents list instead. |
| 9 | `GET /api/receipts` lacks `offset`/`total` | Paginate large receipt histories. | Limit 200, newest first. |
| 10 | `GET /api/counts?assigned_to=me` | Counter's own tasks. | Handheld lists all PENDING/IN_PROGRESS/RECOUNT tasks. |
| 11 | Semantics of area location coordinates | `x_m, y_m` of rack slots are the slot **center**; for area locations (docks, staging…) the seed uses the **corner**. Not documented in the API. | `mapModel.ts` treats `rack_id == null` as corner semantics. |
| 12 | `POST /api/labels/print` when the printer is unreachable answers **422 `PRINTER_UNREACHABLE`** after creating a FAILED `label_prints` row | The demo printers (192.168.1.50/51) are not reachable from a dev box, so every print from the UI ends as a blocking error although the ZPL is correct. | The UI shows the preview (PNG barcode/QR + ZPL) and reports the failure; history shows the FAILED row. |

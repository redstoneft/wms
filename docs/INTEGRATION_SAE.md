# Integración con Aspel SAE

## Cómo llega la información

SAE (Firebird 2.5, servidor Windows de la oficina) **no se consulta directamente**. Dos conectores que ya operan en ese servidor como tareas del sistema replican SAE a Supabase:

| Fuente | Proyecto Supabase | Cadencia | Tablas que usa el WMS |
|---|---|---|---|
| Espejo crudo (`SAE-Sync-Supabase`) | `dalrmzvtupewnzjvtsai` | cada hora | `sae_inve01` (artículos), `sae_clie01` (clientes), `sae_prov01` (proveedores) |
| Limpio del ERP (`RedstoneConectorSAE`) | `xnusxtojbnyyfziyjmcr` "PEDIDOS" | cada 30 min | `sae_inventario` (existencias), `sae_compras` + `sae_compras_lineas` (órdenes de compra), `sku_alias` (modelo/capa), `productos` (GTIN), `clientes`, `cedis`, `pedidos` + `pedido_lineas` (órdenes de compra de clientes retail) |

El WMS lee ambas fuentes por PostgREST (solo lectura, paginado de 1,000 filas) con las credenciales de `.env` (`SAE_SUPABASE_URL/KEY` = ERP con service key; `SAE_RAW_SUPABASE_URL/KEY` = espejo crudo con la anon key de solo lectura). Nunca escribe en Supabase ni en SAE.

## Qué sincroniza y con qué reglas

| Entidad | Origen | Regla |
|---|---|---|
| **SKUs** | `sae_inve01` + `sku_alias` + `productos` + `pedido_lineas` | Cada clave SAE (`CVE_ART`, recortada) es un SKU del WMS: SAE maneja el mismo producto físico como varias claves (BASE, PIEZA `-1`, CAJA `.`/`.` inicial). Se agrupan con `model_code` y `packaging_layer` tomados de `sku_alias`. Descripción, familia (`LIN_PROD`), peso, lote (`CON_LOTE`) y estatus (A activo / B baja) vienen de SAE. **Conversión CASE** = `piezas_por_caja` observado en pedidos del cliente para esa clave (o su modelo), si no `UNI_EMP` cuando > 1. Si el WMS ya tiene una conversión distinta **no se cambia**: se reporta. **GTIN** de `productos` se registra como código de barras por pieza (si ya pertenece a otro SKU se reporta). Claves que desaparecen de SAE se desactivan solo si no tienen inventario. |
| **Clientes** | `sae_clie01` + `clientes` (plataforma) | Clave SAE recortada como código, nombre, RFC, domicilio. Las cuentas retail de la plataforma (WMT, HEB, …) se crean aparte salvo que tengan `cliente_sae_id` enlazado. |
| **Proveedores** | `sae_prov01` | Clave recortada, nombre, RFC, contacto. |
| **Órdenes de compra** | `sae_compras` estado `E` con fecha ≥ hoy − `SAE_PO_SINCE_DAYS` (60) | Número = `CVE_DOC` recortado, proveedor por clave, fecha esperada = `FECHA_REC`, líneas agregadas por artículo (piezas). Una OC que ya tiene recepciones en el WMS no se reescribe; canceladas (`C`) y antiguas se ignoran. Al abrir una recepción con la OC, el WMS compara esperado vs recibido automáticamente. |
| **Pedidos de clientes** | `pedidos` + `pedido_lineas` + `cedis` | Número = orden de compra del cliente; cliente = cuenta de la plataforma; destino = CEDIS; prioridad según días a `fecha_cancelacion`; líneas en piezas (`cantidad_surtir`). El SKU se resuelve por clave exacta, variantes con punto, GTIN o capa BASE del modelo; si **una** línea no resuelve, el pedido completo se rechaza y queda en el reporte (nunca se crea un pedido incompleto). Un pedido que ya está en surtido en el WMS no se reescribe. Si la plataforma lo cancela: se cancela en el WMS mientras no haya surtido; si ya se surte, se abre una incidencia HIGH. Estados cerrados de la plataforma se ignoran. |
| **Existencias** | `sae_inventario` | Solo **comparación** (`GET /api/sae/stock-compare`): existencia SAE vs total WMS por clave. El WMS jamás crea inventario desde SAE; las diferencias se resuelven con conteos y ajustes autorizados. |

Orden de ejecución: proveedores → clientes → SKUs → órdenes de compra → pedidos (para que los documentos encuentren sus referencias).

## Ejecución

* Automática cada `SAE_SYNC_INTERVAL_MINUTES` (30) en la API, con bloqueo advisory para que solo una instancia sincronice.
* Manual: `POST /api/sae/sync` (`{ "entities": ["skus", ...] }` opcional), permiso `imports.run`.
* Estado: `GET /api/sae/status` (configuración sin claves, frescura de ambas fuentes, conteos en el WMS, último run por entidad). Historial: `GET /api/sae/runs`.
* Cada corrida queda en `integration_runs` (filas origen, creados, actualizados, omitidos, errores por referencia) y en la auditoría.

## Lo que hay que saber

* Los pedidos de SAE (`FACTP01`) están vacíos en tu instalación: los pedidos operativos son las órdenes de compra de los clientes retail en la plataforma PEDIDOS, y así se importan.
* SAE no tiene códigos de barras en `CVE_BARRA`; los GTIN vienen del catálogo de la plataforma.
* Las órdenes de compra de SAE traen cantidades en piezas y pueden repetir un artículo en varias líneas; se agregan.
* Nada se borra en el WMS por efecto de la sincronización: solo se crean, actualizan o desactivan registros, y todo intento fallido queda listado con su referencia para corregir en SAE.
* Salida hacia SAE: no existe un canal de escritura hacia Firebird. El WMS expone el estado de cada pedido (`GET /api/integrations/sae/orders/:numero/status`) y el inventario (`GET /api/integrations/inventory`) por API key para que un conector externo alimente SAE o la plataforma.

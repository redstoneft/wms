# Capacitación guiada obligatoria (modo almacén)

Todo usuario nuevo (excepto rol `ADMIN`) tiene que completar una capacitación guiada antes de operar en el modo almacén. No es un video ni un cuestionario: son las operaciones reales, en las pantallas reales del handheld, sobre un **almacén escuela** aislado (`ESCUELA`) que nunca toca el inventario de la nave.

## Cómo funciona

1. Al entrar al modo almacén, el usuario solo ve **Capacitación guiada**; las demás pantallas redirigen a la guía hasta que termine. Una franja ámbar "MODO CAPACITACIÓN" aparece mientras dura.
2. La guía muestra un paso a la vez, en este orden y solo los que corresponden a los permisos del rol: Recibir → Ubicar → Traslados → Reabasto → Conteo → Armado → Surtir → Staging → Verificar → Cargar.
3. En cada paso: **Preparar ejercicio** (el servidor crea la recepción, el pallet, la tarea o el pedido de práctica para ese usuario), la pantalla muestra qué códigos va a escanear y los pasos, **Ir a la pantalla** (abre la pantalla real) y **Ya lo hice, verificar**.
4. La verificación no confía en el usuario: el servidor busca en el ledger y en las tareas que **ese usuario** hizo la operación después de preparar el ejercicio (movimiento de recepción, tarea de acomodo confirmada, traslado completado, conteo cerrado, orden de armado, movimientos de surtido/staging/carga, verificación aprobada). Si falta algo, la guía dice exactamente qué.
5. Al completar el último paso queda registrado `training_completed_at` en el usuario y el modo almacén se abre completo. Todo queda en auditoría (`training.prepare`, `training.step_completed`, `training.completed`).

Para verificar y cargar, el servidor surte y verifica el pedido con un actor interno (`escuela`, `escuela-surtidor`) porque una persona no puede verificar lo que ella misma surtió.

## Almacén escuela

Se crea solo la primera vez que alguien entra a la guía: zonas de recibo, staging, embarque, un rack de reserva (`ESC-ALM-A-R01-…`, 4 módulos × 2 niveles), una cara de picking (`ESC-PCK-P-R01-…`), andén `ESC-DOCK-01`, staging/estación de armado `ESC-STG-01`, andén de salida `ESC-SHIP-01`, productos `CAP-001`, `CAP-002`, `CAP-003` (códigos de barras `CAP001`/`CAP001C`, etc.), cliente, proveedor y transporte de práctica.

**Etiquetas de práctica**: `GET /api/training/labels.html` (enlace en la guía y en Usuarios). Imprimirlas una vez, plastificar y pegar en el área de capacitación. Todo lo que se escanee con ellas ocurre en la escuela.

Los pallets de práctica se reutilizan entre usuarios; los pedidos cargados salen de la escuela. Si el rack escuela se llena, el supervisor embarca o consume los pallets de práctica (la guía lo avisa con `SCHOOL_FULL`).

## Administración

* **Usuarios** (oficina): columna "Capacitación" (Pendiente · n pasos / Completada / Exento) y acciones **Reiniciar capacitación** (borra el avance, vuelve a la guía) y **Marcar capacitado** (exención con motivo, auditada). Requiere `exceptions.authorize` (supervisor o admin).
* **Configuración**: casilla "Capacitación guiada obligatoria"; apagada, nadie es bloqueado (la guía sigue disponible en el menú).
* API: `GET /training`, `POST /training/steps/:step/prepare|check`, `GET /training/labels.html`, `GET /training/users`, `POST /training/users/:id/reset|waive`.

## Recomendación de arranque

Imprimir las etiquetas de práctica, dar de alta a cada operador con su rol, y hacer la capacitación con el supervisor al lado la primera vez (30–45 minutos por persona con todos los pasos). Después, cada usuario nuevo la hace solo.

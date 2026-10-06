// /wm/print-queue — see and empty the label print queue from the handheld (a station printing the wrong batch, labels sent twice…).
import { PrintQueueCard } from '../components/PrintQueueCard';
import { StepBar, useWm, WmShell } from './WmShell';

export default function WmPrintQueuePage() {
  return (
    <WmShell title="Cola de impresión">
      <Inner />
    </WmShell>
  );
}
function Inner() {
  const wm = useWm();
  return (
    <div>
      <StepBar text="ETIQUETAS PENDIENTES DE IMPRIMIR" />
      <PrintQueueCard big onDone={(m) => wm.ok(m.toUpperCase())} />
      <div className="mt-3 text-xs text-slate-400">Vaciar cancela lo que aún no se imprime. Lo que ya salió de la impresora no se puede cancelar; si hace falta, vuelve a imprimir desde Etiquetas.</div>
    </div>
  );
}

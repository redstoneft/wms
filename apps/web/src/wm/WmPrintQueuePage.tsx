// /wm/print-queue — see and empty the label print queue from the handheld (a station printing the wrong batch, labels sent twice…),
// and download the station launcher for the PC that has the Zebra.
import { useQuery } from '@tanstack/react-query';
import { masterdataApi } from '../api/masterdata';
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
  const printers = useQuery({ queryKey: ['printers'], queryFn: masterdataApi.printers });
  const stations = (printers.data ?? []).filter((p) => p.mode === 'AGENT' && p.is_active);
  return (
    <div>
      <StepBar text="ETIQUETAS PENDIENTES DE IMPRIMIR" />
      <PrintQueueCard big onDone={(m) => wm.ok(m.toUpperCase())} />
      <div className="mt-3 text-xs text-slate-400">Vaciar cancela lo que aún no se imprime. Lo que ya salió de la impresora no se puede cancelar; si hace falta, vuelve a imprimir desde Etiquetas.</div>
      {stations.length > 0 && (
        <div className="mt-4 rounded-2xl bg-slate-900 p-3">
          <div className="mb-1 text-xs font-bold uppercase text-slate-400">Estación de impresión (PC de la Zebra)</div>
          {stations.map((p) => {
            const online = p.agent_last_seen_at ? Date.now() - new Date(p.agent_last_seen_at).getTime() < 90_000 : false;
            return (
              <div key={p.id} className="flex items-center justify-between gap-2 py-1">
                <div className="text-sm">
                  <div className="font-bold">{p.name}</div>
                  <div className={online ? 'text-emerald-400' : 'text-rose-400'}>{online ? 'conectada' : 'SIN CONEXIÓN: descarga la estación en esa PC y dale doble clic'}</div>
                </div>
                <a className="rounded-xl bg-emerald-600 px-3 py-2 text-sm font-black text-white" href={`/api/printers/${p.id}/station.bat`} download="estacion_wms.bat">Descargar estación</a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

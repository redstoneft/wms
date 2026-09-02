// React-three-fiber scene for the digital twin. Everything repeated is an
// InstancedMesh (slots, pallets, rack uprights/beams); labels only for zones
// and racks; LOD swaps detailed pallets for flat boxes when the camera is far.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Canvas, useFrame, useThree, type ThreeEvent } from '@react-three/fiber';
import { Html, OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { Warehouse, WarehouseFeatures, Zone } from '../api/types';
import { HIGHLIGHT_COLOR, PALLET_BASE_COLOR, PALLET_LOAD_COLOR, SELECT_COLOR, STATUS_COLORS, type FrameInstance, type SceneModel, type Vec3 } from './mapModel';

export interface FlyTarget {
  seq: number;
  position: Vec3;
  lookAt: Vec3;
}
export interface HoverInfo {
  id: string;
  x: number;
  y: number;
}
export interface MapSceneProps {
  model: SceneModel;
  warehouse: Warehouse;
  zones: Zone[];
  visible: Set<string> | null; // null = everything visible
  highlight: Set<string>;
  selectedId: string | null;
  selectedRackId: string | null;
  editMode: boolean;
  fly: FlyTarget | null;
  onHover: (h: HoverInfo | null) => void;
  onSelect: (id: string | null) => void;
  onSelectRack: (rackId: string) => void;
  onFar: (far: boolean) => void;
  far: boolean;
}

const dummy = new THREE.Object3D();
const tmpColor = new THREE.Color();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
const LOD_DISTANCE = 75;

function setInstance(mesh: THREE.InstancedMesh, i: number, center: Vec3, size: Vec3, rotY = 0) {
  dummy.position.set(center[0], center[1], center[2]);
  dummy.rotation.set(0, rotY, 0);
  dummy.scale.set(size[0], size[1], size[2]);
  dummy.updateMatrix();
  mesh.setMatrixAt(i, dummy.matrix);
}

// ---------------------------------------------------------------- floor & zones
function Floor({ width, depth }: { width: number; depth: number }) {
  const divisions = Math.max(1, Math.round(Math.max(width, depth) / 2));
  return (
    <group>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[width / 2, -0.01, depth / 2]} receiveShadow>
        <planeGeometry args={[width + 4, depth + 4]} />
        <meshStandardMaterial color="#e2e8f0" roughness={1} />
      </mesh>
      <gridHelper args={[Math.max(width, depth) + 4, divisions * 2, '#94a3b8', '#cbd5e1']} position={[width / 2, 0, depth / 2]} />
      {/* outer wall outline */}
      <lineSegments position={[width / 2, 0.02, depth / 2]}>
        <edgesGeometry args={[new THREE.BoxGeometry(width, 0.04, depth)]} />
        <lineBasicMaterial color="#0f172a" />
      </lineSegments>
    </group>
  );
}

function Zones({ zones }: { zones: Zone[] }) {
  return (
    <group>
      {zones.map((z) => {
        const x = Number(z.x_m);
        const y = Number(z.y_m);
        const w = Number(z.width_m);
        const d = Number(z.depth_m);
        const color = z.color ?? '#94a3b8';
        return (
          <group key={z.id} position={[x + w / 2, 0.005, y + d / 2]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]}>
              <planeGeometry args={[w, d]} />
              <meshBasicMaterial color={color} transparent opacity={0.22} depthWrite={false} />
            </mesh>
            <lineSegments rotation={[-Math.PI / 2, 0, 0]}>
              <edgesGeometry args={[new THREE.PlaneGeometry(w, d)]} />
              <lineBasicMaterial color={color} />
            </lineSegments>
            <Html position={[-w / 2 + 0.3, 0.05, -d / 2 + 0.3]} zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }} transform={false}>
              <div className="whitespace-nowrap rounded bg-slate-900/70 px-1.5 py-0.5 text-[11px] font-bold text-white" style={{ borderLeft: `3px solid ${color}` }}>
                {z.code} · {z.name}
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------- building (survey geometry)
const OPENING_STYLE: Record<string, { color: string; height: number }> = {
  PORTON: { color: '#0ea5e9', height: 4.5 },
  PUERTA: { color: '#38bdf8', height: 2.2 },
  RAMPA: { color: '#f59e0b', height: 0.3 },
  ANDEN: { color: '#f59e0b', height: 1.2 },
};
const CONTEXT_STYLE: Record<string, string> = { PATIO: '#d6d3d1', VECINO: '#fda4af', OFICINAS: '#c4b5fd', EXTERIOR: '#e7e5e4', OTRO: '#e2e8f0' };

/** Walls, structural columns, doors/ramps, gable ridges, neighbouring areas and the north arrow, from `warehouse.features`. */
function Building({ warehouse, width, depth, height }: { warehouse: Warehouse; width: number; depth: number; height: number }) {
  const f: WarehouseFeatures | null | undefined = warehouse.features;
  const wallT = 0.25;
  const walls: { pos: Vec3; size: Vec3 }[] = [
    { pos: [width / 2, height / 2, 0], size: [width + wallT, height, wallT] },
    { pos: [width / 2, height / 2, depth], size: [width + wallT, height, wallT] },
    { pos: [0, height / 2, depth / 2], size: [wallT, height, depth] },
    { pos: [width, height / 2, depth / 2], size: [wallT, height, depth] },
  ];
  const openingBox = (o: WarehouseFeatures['openings'][number]): { pos: Vec3; size: Vec3 } => {
    const st = OPENING_STYLE[o.kind] ?? OPENING_STYLE.PUERTA!;
    const h = o.kind === 'RAMPA' ? 0.3 : st.height;
    const out = o.kind === 'RAMPA' || o.kind === 'ANDEN' ? 3 : 0.5; // ramps/docks protrude outside
    switch (o.side) {
      case 'FRONT': return { pos: [o.from + o.width / 2, h / 2, -out / 2], size: [o.width, h, out] };
      case 'BACK': return { pos: [o.from + o.width / 2, h / 2, depth + out / 2], size: [o.width, h, out] };
      case 'LEFT': return { pos: [-out / 2, h / 2, o.from + o.width / 2], size: [out, h, o.width] };
      default: return { pos: [width + out / 2, h / 2, o.from + o.width / 2], size: [out, h, o.width] };
    }
  };
  const northDeg = f?.north_deg;
  return (
    <group>
      {walls.map((w, i) => (
        <mesh key={i} position={w.pos}>
          <boxGeometry args={w.size} />
          <meshStandardMaterial color="#94a3b8" transparent opacity={0.13} depthWrite={false} />
        </mesh>
      ))}
      {f?.columns.map((c, i) => (
        <mesh key={`c${i}`} position={[c.x, height / 2, c.y]}>
          <boxGeometry args={[c.size, height, c.size]} />
          <meshStandardMaterial color={c.estimated ? '#cbd5e1' : '#64748b'} transparent={!!c.estimated} opacity={c.estimated ? 0.55 : 1} />
        </mesh>
      ))}
      {f?.roof?.spans_x.map((x, i) => (
        <group key={`r${i}`}>
          <mesh position={[x, height + 0.05, depth / 2]}>
            <boxGeometry args={[0.15, 0.1, depth]} />
            <meshBasicMaterial color="#475569" />
          </mesh>
        </group>
      ))}
      {f?.openings.map((o, i) => {
        const b = openingBox(o);
        const st = OPENING_STYLE[o.kind] ?? OPENING_STYLE.PUERTA!;
        return (
          <group key={`o${i}`} position={b.pos}>
            <mesh>
              <boxGeometry args={b.size} />
              <meshStandardMaterial color={st.color} transparent opacity={o.estimated ? 0.45 : 0.8} />
            </mesh>
            <Html position={[0, b.size[1] / 2 + 0.4, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="whitespace-nowrap rounded bg-sky-900/80 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                {o.label ?? o.kind}
                {o.estimated ? ' (aprox.)' : ''}
              </div>
            </Html>
          </group>
        );
      })}
      {f?.context.map((c, i) => (
        <group key={`x${i}`} position={[c.x + c.w / 2, -0.005, c.y + c.d / 2]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[c.w, c.d]} />
            <meshBasicMaterial color={CONTEXT_STYLE[c.kind] ?? '#e2e8f0'} transparent opacity={0.45} depthWrite={false} />
          </mesh>
          <lineSegments rotation={[-Math.PI / 2, 0, 0]}>
            <edgesGeometry args={[new THREE.PlaneGeometry(c.w, c.d)]} />
            <lineBasicMaterial color="#78716c" />
          </lineSegments>
          <Html position={[0, 0.05, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="whitespace-nowrap rounded bg-white/85 px-1.5 py-0.5 text-[10px] font-semibold text-stone-600">{c.label}</div>
          </Html>
        </group>
      ))}
      {f?.exclusions.map((e, i) => (
        <group key={`e${i}`} position={[e.x + e.w / 2, 0.01, e.y + e.d / 2]}>
          <mesh rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[e.w, e.d]} />
            <meshBasicMaterial color="#fecaca" transparent opacity={0.6} depthWrite={false} />
          </mesh>
          <Html position={[0, 0.05, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="whitespace-nowrap rounded bg-rose-700/85 px-1.5 py-0.5 text-[10px] font-semibold text-white">{e.label}</div>
          </Html>
        </group>
      ))}
      {northDeg !== undefined && (
        <group position={[-3, 0.05, -3]} rotation={[0, (northDeg * Math.PI) / 180, 0]}>
          <mesh position={[0, 0, 1]} rotation={[Math.PI / 2, 0, 0]}>
            <cylinderGeometry args={[0.08, 0.08, 2, 8]} />
            <meshBasicMaterial color="#0f172a" />
          </mesh>
          <mesh position={[0, 0, 2.4]} rotation={[Math.PI / 2, 0, 0]}>
            <coneGeometry args={[0.35, 0.9, 12]} />
            <meshBasicMaterial color="#dc2626" />
          </mesh>
          <Html position={[0, 0.3, 3.3]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
            <div className="rounded bg-slate-900/80 px-1.5 py-0.5 text-[11px] font-black text-white">N</div>
          </Html>
        </group>
      )}
    </group>
  );
}

// ---------------------------------------------------------------- rack frames
function Frames({ items, color, editMode, onSelectRack, selectedRackId }: { items: FrameInstance[]; color: string; editMode: boolean; onSelectRack: (id: string) => void; selectedRackId: string | null }) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    items.forEach((it, i) => {
      setInstance(m, i, it.center, it.size, it.rotY);
      tmpColor.set(it.rackId === selectedRackId ? SELECT_COLOR : color);
      m.setColorAt(i, tmpColor);
    });
    m.count = items.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [items, color, selectedRackId, invalidate]);
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (!editMode || e.instanceId === undefined) return;
    e.stopPropagation();
    const it = items[e.instanceId];
    if (it) onSelectRack(it.rackId);
  };
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, Math.max(1, items.length)]} frustumCulled={false} onClick={onClick}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ffffff" metalness={0.4} roughness={0.5} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- slots
function Slots({ model, visible, highlight, selectedId, onHover, onSelect }: Pick<MapSceneProps, 'model' | 'visible' | 'highlight' | 'selectedId' | 'onHover' | 'onSelect'>) {
  const ref = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const { slots } = model;
  useLayoutEffect(() => {
    const m = ref.current;
    if (!m) return;
    slots.forEach((s, i) => {
      const show = !visible || visible.has(s.loc.id);
      if (show) setInstance(m, i, s.center, s.size);
      else m.setMatrixAt(i, ZERO);
      const hl = highlight.has(s.loc.id);
      tmpColor.set(s.loc.id === selectedId ? SELECT_COLOR : hl ? HIGHLIGHT_COLOR : STATUS_COLORS[s.loc.status] ?? '#999999');
      m.setColorAt(i, tmpColor);
    });
    m.count = slots.length;
    m.instanceMatrix.needsUpdate = true;
    if (m.instanceColor) m.instanceColor.needsUpdate = true;
    m.computeBoundingSphere();
    invalidate();
  }, [slots, visible, highlight, selectedId, invalidate]);

  const lastHover = useRef<number | null>(null);
  const onMove = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    if (lastHover.current === e.instanceId) return;
    lastHover.current = e.instanceId;
    const s = slots[e.instanceId];
    if (s) onHover({ id: s.loc.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    lastHover.current = null;
    onHover(null);
  };
  const onClick = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    const s = slots[e.instanceId];
    if (s) onSelect(s.loc.id);
  };
  return (
    <instancedMesh ref={ref} args={[undefined, undefined, Math.max(1, slots.length)]} frustumCulled={false} onPointerMove={onMove} onPointerOut={onOut} onClick={onClick}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ffffff" transparent opacity={0.2} depthWrite={false} roughness={0.9} />
    </instancedMesh>
  );
}

// ---------------------------------------------------------------- pallets (LOD)
function Pallets({ model, visible, highlight, selectedId, far, onHover, onSelect }: Pick<MapSceneProps, 'model' | 'visible' | 'highlight' | 'selectedId' | 'far' | 'onHover' | 'onSelect'>) {
  const baseRef = useRef<THREE.InstancedMesh>(null);
  const loadRef = useRef<THREE.InstancedMesh>(null);
  const simpleRef = useRef<THREE.InstancedMesh>(null);
  const invalidate = useThree((s) => s.invalidate);
  const { pallets } = model;
  const BASE_H = 0.14;

  useLayoutEffect(() => {
    const b = baseRef.current;
    const l = loadRef.current;
    const s = simpleRef.current;
    pallets.forEach((p, i) => {
      const show = !visible || visible.has(p.locId);
      const [cx, cy, cz] = p.center;
      const [w, h, d] = p.size;
      const bottom = cy - h / 2;
      const hl = highlight.has(p.locId);
      const sel = p.locId === selectedId;
      if (b && l) {
        if (show && !far) {
          setInstance(b, i, [cx, bottom + BASE_H / 2, cz], [w, BASE_H, d]);
          const lh = Math.max(0.2, h - BASE_H);
          setInstance(l, i, [cx, bottom + BASE_H + lh / 2, cz], [w * 0.96, lh, d * 0.96]);
        } else {
          b.setMatrixAt(i, ZERO);
          l.setMatrixAt(i, ZERO);
        }
        tmpColor.set(sel ? SELECT_COLOR : hl ? HIGHLIGHT_COLOR : PALLET_BASE_COLOR);
        b.setColorAt(i, tmpColor);
        tmpColor.set(sel ? SELECT_COLOR : hl ? HIGHLIGHT_COLOR : PALLET_LOAD_COLOR);
        l.setColorAt(i, tmpColor);
      }
      if (s) {
        if (show && far) setInstance(s, i, p.center, p.size);
        else s.setMatrixAt(i, ZERO);
        tmpColor.set(sel ? SELECT_COLOR : hl ? HIGHLIGHT_COLOR : STATUS_COLORS[p.status] ?? '#3b82f6');
        s.setColorAt(i, tmpColor);
      }
    });
    for (const m of [b, l, s]) {
      if (!m) continue;
      m.count = pallets.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
    }
    invalidate();
  }, [pallets, visible, highlight, selectedId, far, invalidate]);

  const hover = (e: ThreeEvent<PointerEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    const p = pallets[e.instanceId];
    if (p) onHover({ id: p.locId, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const click = (e: ThreeEvent<MouseEvent>) => {
    if (e.instanceId === undefined) return;
    e.stopPropagation();
    const p = pallets[e.instanceId];
    if (p) onSelect(p.locId);
  };
  const n = Math.max(1, pallets.length);
  return (
    <group>
      <instancedMesh ref={baseRef} args={[undefined, undefined, n]} frustumCulled={false} onPointerMove={hover} onPointerOut={() => onHover(null)} onClick={click} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.95} />
      </instancedMesh>
      <instancedMesh ref={loadRef} args={[undefined, undefined, n]} frustumCulled={false} onPointerMove={hover} onPointerOut={() => onHover(null)} onClick={click} castShadow>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.9} />
      </instancedMesh>
      <instancedMesh ref={simpleRef} args={[undefined, undefined, n]} frustumCulled={false} onPointerMove={hover} onPointerOut={() => onHover(null)} onClick={click}>
        <boxGeometry args={[1, 1, 1]} />
        <meshStandardMaterial color="#ffffff" roughness={0.8} />
      </instancedMesh>
    </group>
  );
}

// ---------------------------------------------------------------- areas
function Areas({ model, visible, highlight, selectedId, onHover, onSelect }: Pick<MapSceneProps, 'model' | 'visible' | 'highlight' | 'selectedId' | 'onHover' | 'onSelect'>) {
  return (
    <group>
      {model.areas.map((a) => {
        const hidden = visible && !visible.has(a.loc.id);
        const color = a.loc.id === selectedId ? SELECT_COLOR : highlight.has(a.loc.id) ? HIGHLIGHT_COLOR : STATUS_COLORS[a.loc.status] ?? '#999';
        return (
          <group key={a.loc.id} position={a.center}>
            <mesh
              onPointerMove={(e) => {
                e.stopPropagation();
                onHover({ id: a.loc.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
              }}
              onPointerOut={() => onHover(null)}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(a.loc.id);
              }}
            >
              <boxGeometry args={a.size} />
              <meshStandardMaterial color={color} transparent opacity={hidden ? 0.15 : 0.75} roughness={0.8} />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(...a.size)]} />
              <lineBasicMaterial color="#334155" />
            </lineSegments>
            <Html position={[0, 0.4, 0]} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
              <div className="whitespace-nowrap rounded bg-white/90 px-1.5 py-0.5 text-[11px] font-bold text-slate-800 shadow" style={{ opacity: hidden ? 0.4 : 1 }}>
                {a.loc.code}
                <span className="ml-1 font-normal text-slate-500">
                  {a.loc.lpn_count}/{a.loc.pallet_capacity}
                </span>
              </div>
            </Html>
          </group>
        );
      })}
    </group>
  );
}

function RackLabels({ model, far }: { model: SceneModel; far: boolean }) {
  if (far) return null;
  return (
    <group>
      {model.rackLabels.map((l) => (
        <Html key={l.rack.id} position={l.pos} center zIndexRange={[10, 0]} style={{ pointerEvents: 'none' }}>
          <div className="whitespace-nowrap rounded bg-slate-800/85 px-1.5 py-0.5 text-[11px] font-semibold text-white">
            {l.rack.zone_code}-{l.rack.aisle_code} {l.rack.code}
          </div>
        </Html>
      ))}
    </group>
  );
}

// ---------------------------------------------------------------- highlights (pulsing emissive)
function Highlights({ model, highlight, selectedId }: { model: SceneModel; highlight: Set<string>; selectedId: string | null }) {
  const ids = useMemo(() => {
    const out = [...highlight].slice(0, 300);
    if (selectedId && !highlight.has(selectedId)) out.push(selectedId);
    return out;
  }, [highlight, selectedId]);
  const mat = useRef<THREE.MeshStandardMaterial>(null);
  const invalidate = useThree((s) => s.invalidate);
  useFrame(({ clock }) => {
    if (!mat.current || ids.length === 0) return;
    mat.current.emissiveIntensity = 0.6 + 0.4 * Math.sin(clock.elapsedTime * 4);
    invalidate();
  });
  if (ids.length === 0) return null;
  return (
    <group>
      {ids.map((id) => {
        const loc = model.locById.get(id);
        if (!loc) return null;
        const isSel = id === selectedId;
        const area = !loc.rack_id;
        const center: Vec3 = area ? [loc.x + loc.w / 2, loc.h / 2 + 0.05, loc.y + loc.d / 2] : [loc.x, loc.z + loc.h / 2, loc.y];
        const size: Vec3 = area ? [loc.w, loc.h, loc.d] : [loc.w, loc.h, loc.d];
        return (
          <mesh key={id} position={center} scale={size} renderOrder={5}>
            <boxGeometry args={[1, 1, 1]} />
            <meshStandardMaterial ref={mat} color={isSel ? SELECT_COLOR : HIGHLIGHT_COLOR} emissive={isSel ? SELECT_COLOR : HIGHLIGHT_COLOR} emissiveIntensity={0.8} transparent opacity={0.35} depthWrite={false} />
          </mesh>
        );
      })}
    </group>
  );
}

// ---------------------------------------------------------------- camera: fly-to + LOD watcher
function CameraRig({ fly, controls, center, onFar, far }: { fly: FlyTarget | null; controls: RefObject<OrbitControlsImpl | null>; center: Vec3; onFar: (f: boolean) => void; far: boolean }) {
  const { camera, invalidate } = useThree();
  const anim = useRef<{ seq: number; t: number; fromPos: THREE.Vector3; fromTarget: THREE.Vector3; toPos: THREE.Vector3; toTarget: THREE.Vector3 } | null>(null);
  const farRef = useRef(far);
  farRef.current = far;

  useEffect(() => {
    if (!fly || !controls.current) return;
    anim.current = {
      seq: fly.seq,
      t: 0,
      fromPos: camera.position.clone(),
      fromTarget: controls.current.target.clone(),
      toPos: new THREE.Vector3(...fly.position),
      toTarget: new THREE.Vector3(...fly.lookAt),
    };
    invalidate();
  }, [fly, camera, controls, invalidate]);

  useFrame((_, delta) => {
    const a = anim.current;
    if (a && controls.current) {
      a.t = Math.min(1, a.t + delta / 1.0);
      const k = a.t < 0.5 ? 2 * a.t * a.t : -1 + (4 - 2 * a.t) * a.t; // easeInOutQuad
      camera.position.lerpVectors(a.fromPos, a.toPos, k);
      controls.current.target.lerpVectors(a.fromTarget, a.toTarget, k);
      controls.current.update();
      if (a.t >= 1) anim.current = null;
      invalidate();
    }
    const dist = camera.position.distanceTo(new THREE.Vector3(center[0], 0, center[2]));
    const isFar = dist > LOD_DISTANCE;
    if (isFar !== farRef.current) {
      farRef.current = isFar;
      onFar(isFar);
    }
  });
  return null;
}

// ---------------------------------------------------------------- root
export function MapScene(props: MapSceneProps) {
  const { model, warehouse, zones, fly, onFar, far, editMode, selectedRackId, onSelectRack } = props;
  const controls = useRef<OrbitControlsImpl | null>(null);
  const center: Vec3 = [model.width / 2, 0, model.depth / 2];
  const camPos: Vec3 = [model.width * 1.25, Math.max(model.width, model.depth) * 1.0, -model.depth * 1.05];
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);

  return (
    <Canvas
      shadows={false}
      dpr={[1, 1.5]}
      frameloop="demand"
      camera={{ position: camPos, fov: 45, near: 0.5, far: 2000 }}
      onPointerMissed={() => props.onSelect(null)}
      gl={{ antialias: true, powerPreference: 'high-performance' }}
      style={{ background: 'linear-gradient(#e0f2fe, #f8fafc)' }}
      data-testid="map-canvas"
    >
      <ambientLight intensity={0.9} />
      <directionalLight position={[model.width, 60, model.depth * 0.3]} intensity={1.1} />
      <hemisphereLight args={['#ffffff', '#cbd5e1', 0.5]} />
      <Floor width={model.width} depth={model.depth} />
      <Building warehouse={warehouse} width={model.width} depth={model.depth} height={model.height} />
      <Zones zones={zones} />
      <Frames items={model.uprights} color="#2563eb" editMode={editMode} onSelectRack={onSelectRack} selectedRackId={selectedRackId} />
      <Frames items={model.beams} color="#f59e0b" editMode={editMode} onSelectRack={onSelectRack} selectedRackId={selectedRackId} />
      <Slots {...props} />
      <Pallets {...props} />
      <Areas {...props} />
      <RackLabels model={model} far={far} />
      <Highlights model={model} highlight={props.highlight} selectedId={props.selectedId} />
      <OrbitControls ref={controls} makeDefault target={center} maxPolarAngle={Math.PI / 2.05} minDistance={3} maxDistance={400} enableDamping dampingFactor={0.12} />
      {ready && <CameraRig fly={fly} controls={controls} center={center} onFar={onFar} far={far} />}
    </Canvas>
  );
}

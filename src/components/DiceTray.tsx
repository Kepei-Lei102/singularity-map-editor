import { useCallback, useEffect, useId, useRef, useState } from 'react';

export type DicePersona = 'witness' | 'player';
export type DiceSides = 4 | 6 | 8 | 10 | 12 | 20 | 100;
export type DiceMaterial = 'wood' | 'plastic' | 'metal' | 'stone' | 'rubber';
export interface DiceTrayLaunch {
  control: 'tray-bowl-v12';
  atX: number;
  atY: number;
  height: number;
  heightMode: 'fixed';
  randomSeed: string;
}
/** A settled, authoritative result. Rendering it never triggers onResult. */
export interface DiceTrayDisplayResult {
  id: string;
  sides: DiceSides;
  value: number;
  seed: number;
  material: DiceMaterial;
  tens?: number | null;
  units?: number | null;
  persona?: DicePersona;
}
export interface DiceTrayRecord extends DiceTrayDisplayResult {
  tens: number | null;
  units: number | null;
  persona: DicePersona;
  launch: DiceTrayLaunch;
  algorithm: string;
  day: string;
  localTime: string;
  source: 'ui';
  schemaVersion: 1;
  requestId?: string;
  rollId?: string;
}
export interface DiceTrayProps {
  persona: DicePersona;
  sides: DiceSides;
  disabled?: boolean;
  /** Metadata for the next user throw; changing it rearms, but does not roll. */
  requestId?: string;
  rollId?: string;
  /** Show another client's result using this tray's fixed persona. */
  displayResult?: DiceTrayDisplayResult | null;
  onResult: (record: DiceTrayRecord) => void;
  onError?: (message: string) => void;
  className?: string;
}

const PROTOCOL = 'singularity-dice-v1';
const SIDES: number[] = [4, 6, 8, 10, 12, 20, 100];
const MATERIALS: string[] = ['wood', 'plastic', 'metal', 'stone', 'rubber'];
function isRecord(value: unknown): value is DiceTrayRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as DiceTrayRecord;
  const l = r.launch;
  return typeof r.id === 'string' && r.id.length > 0 && SIDES.includes(r.sides)
    && Number.isInteger(r.value) && r.value >= 1 && r.value <= r.sides
    && Number.isSafeInteger(r.seed) && r.seed >= 0 && MATERIALS.includes(r.material)
    && (r.persona === 'witness' || r.persona === 'player') && typeof r.algorithm === 'string'
    && typeof r.day === 'string' && typeof r.localTime === 'string' && r.source === 'ui' && r.schemaVersion === 1
    && [r.requestId, r.rollId].every(v => v === undefined || typeof v === 'string')
    && (r.sides === 100 ? Number.isInteger(r.tens) && r.tens! >= 0 && r.tens! <= 90 && r.tens! % 10 === 0
      && Number.isInteger(r.units) && r.units! >= 0 && r.units! <= 9 && (r.tens! + r.units! || 100) === r.value
      : r.tens === null && r.units === null)
    && !!l && l.control === 'tray-bowl-v12' && l.heightMode === 'fixed'
    && Number.isFinite(l.atX) && Math.abs(l.atX) <= 1 && Number.isFinite(l.atY) && Math.abs(l.atY) <= 1
    && Number.isFinite(l.height) && l.height >= 5 && l.height <= 28
    && typeof l.randomSeed === 'string' && /^[0-9a-f]{64}$/.test(l.randomSeed);
}

/** Requires public/dice beside the served app, including in player builds. */
export function DiceTray(props: DiceTrayProps) {
  const frame = useRef<HTMLIFrameElement>(null);
  const current = useRef(props);
  current.current = props;
  const channel = useId();
  const [attempt, setAttempt] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seen = useRef(new Set<string>());
  const source = `${import.meta.env.BASE_URL}dice/embed.html#channel=${encodeURIComponent(channel)}`;
  const configure = useCallback(() => {
    const p = current.current;
    frame.current?.contentWindow?.postMessage({ protocol: PROTOCOL, channel, type: 'configure', config: {
      persona: p.persona, sides: p.sides, disabled: !!p.disabled,
      requestId: p.requestId, rollId: p.rollId, displayResult: p.displayResult ?? null,
    } }, window.location.origin);
  }, [channel]);

  useEffect(() => {
    if (location.protocol === 'file:') {
      setError('骰盘需要 HTTP 服务及旁边的 dice 资源目录。单文件离线版无法载入三维骰盘。');
      return;
    }
    let connected = false;
    const timer = window.setTimeout(() => {
      if (!connected) setError('骰盘未能载入。请确认当前服务提供 dice/embed.html 及骰子资源，然后重试。');
    }, 20000);
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frame.current?.contentWindow) return;
      const data = event.data;
      if (!data || data.protocol !== PROTOCOL || data.channel !== channel) return;
      if (data.type === 'ready') {
        connected = true; window.clearTimeout(timer); setReady(true); setError(null); configure();
      } else if (data.type === 'error' && typeof data.message === 'string') {
        setError(data.message); current.current.onError?.(data.message);
      } else if (data.type === 'result' && isRecord(data.record)) {
        const record = data.record;
        if (seen.current.has(record.id)) return;
        // A throw retains the request metadata captured at release, even if props
        // changed while it was in flight. The caller decides if it is still current.
        seen.current.add(record.id);
        if (seen.current.size > 128) seen.current.delete(seen.current.values().next().value!);
        setError(null); current.current.onResult(record);
      }
    };
    window.addEventListener('message', receive);
    return () => { window.clearTimeout(timer); window.removeEventListener('message', receive); };
  }, [channel, configure, attempt]);

  useEffect(() => { if (ready) configure(); }, [ready, configure, props.persona, props.sides, props.disabled, props.requestId, props.rollId, props.displayResult]);

  return (
    <section className={props.className} aria-label={props.persona === 'witness' ? '见证者骰盘' : '玩家骰盘'}>
      <iframe key={attempt} ref={frame} src={source} title={props.persona === 'witness' ? '见证者月亮骰盘' : '玩家群星骰盘'}
        onLoad={configure} style={{ display: 'block', width: '100%', height: 560, border: 0, borderRadius: 8 }} />
      {error && <div role="alert" style={{ padding: '8px 12px' }}>{error}{' '}
        {location.protocol !== 'file:' && <button type="button" className="small" onClick={() => {
          setReady(false); setError(null); setAttempt(n => n + 1);
        }}>重新打开骰盘</button>}
      </div>}
    </section>
  );
}

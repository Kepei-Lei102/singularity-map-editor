import { useEffect, useRef, useState } from 'react';

// 侧栏宽度可拖、可收起。宽度和开关记在浏览器里。

function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v === null ? fallback : (JSON.parse(v) as T); } catch { return fallback; }
}

export function usePanel(key: string, defaultWidth: number) {
  const [width, setWidth] = useState(() => load(`ts-panel-${key}-w`, defaultWidth));
  const [open, setOpen] = useState(() => load(`ts-panel-${key}-open`, true));
  useEffect(() => { try { localStorage.setItem(`ts-panel-${key}-w`, JSON.stringify(width)); } catch { /* 无痕模式 */ } }, [key, width]);
  useEffect(() => { try { localStorage.setItem(`ts-panel-${key}-open`, JSON.stringify(open)); } catch { /* 无痕模式 */ } }, [key, open]);
  return { width, setWidth, open, setOpen };
}

/** side：分隔条在哪一栏旁边。拖动改宽度，点中间的小按钮或双击收起/展开。 */
export function Splitter({ side, panel, min = 160, max = 640 }: {
  side: 'left' | 'right'; panel: ReturnType<typeof usePanel>; min?: number; max?: number;
}) {
  const drag = useRef<{ x: number; w: number } | null>(null);
  const arrow = side === 'left' ? (panel.open ? '‹' : '›') : (panel.open ? '›' : '‹');
  return (
    <div
      className={`splitter ${panel.open ? '' : 'closed'}`}
      title={panel.open ? '拖动调整宽度；双击收起' : '双击展开'}
      onPointerDown={(e) => {
        if (!panel.open || (e.target as HTMLElement).closest('button')) return;
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: panel.width };
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        const dx = e.clientX - d.x;
        panel.setWidth(Math.round(Math.max(min, Math.min(max, d.w + (side === 'left' ? dx : -dx)))));
      }}
      onPointerUp={() => { drag.current = null; }}
      onDoubleClick={() => panel.setOpen(!panel.open)}
    >
      <button className="splitter-btn" onClick={() => panel.setOpen(!panel.open)} title={panel.open ? '收起' : '展开'}>{arrow}</button>
    </div>
  );
}

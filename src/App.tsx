import { useEffect, useRef } from 'react';
import { canEditMap, getUI, getWorld, redo, setUI, undo, update, useUI, useWorld, type Mode, type Tab } from './store';
import { autoLoadFromLauncher, checkDiskTarget, deleteMapObject, exportProject, findMap, hasBackup, importAnyFile, restoreBackup, saveToDisk, startFreshWorld } from './actions';
import { demoWorld, emptyWorld } from './defaults';
import { broadcastWorld, listenAsEditor, openPlayerWindow, send } from './sync';
import { storageOK } from './store';
import { MapCanvas } from './components/MapCanvas';
import { cellName } from './util';
import { Sidebar, TOOL_KEYS, toolsFor } from './components/Sidebar';
import { Inspector } from './components/Inspector';
import { RecordPanel } from './components/RecordPanel';
import { FlowPanel } from './components/FlowPanel';
import { PartyPanel } from './components/PartyPanel';
import { NpcPanel } from './components/NpcPanel';
import { MediaDock, MediaPanel } from './components/MediaPanel';
import { PlayerView } from './components/PlayerView';
import { Splitter, usePanel } from './components/Splitter';
import { endTrial, startTrial, switchTrialPlayer, toggleMarkMode, trialClick, trialEndTurn, trialMove } from './trial';
import { TrialHud } from './components/TrialHud';

const MODES: { mode: Mode; label: string; tab: Tab }[] = [
  { mode: 'edit', label: '编辑地图', tab: 'inspect' },
  { mode: 'prep', label: '备团', tab: 'inspect' },
  { mode: 'run', label: '带团', tab: 'log' },
];
const TABS: Record<Mode, [Tab, string][]> = {
  edit: [['inspect', '检查器'], ['media', '媒体库']],
  prep: [['inspect', '检查器'], ['party', '队伍'], ['npc', 'NPC'], ['media', '媒体库']],
  run: [['inspect', '检查器'], ['log', '记录'], ['party', '队伍'], ['npc', 'NPC'], ['media', '媒体库']],
};

export default function App() {
  return new URLSearchParams(location.search).get('view') === 'player' ? <PlayerView /> : <Editor />;
}

function deleteSelection() {
  const sel = getUI().selection;
  if (!sel) return;
  if (sel.type !== 'token' && !canEditMap(getUI())) return;
  if (sel.type === 'object') return deleteMapObject(sel.mapId, sel.id);
  update((d) => {
    if (sel.type === 'token') { const m = findMap(d, sel.mapId); if (m) m.tokens = m.tokens.filter((t) => t.id !== sel.id); }
    if (sel.type === 'conn') d.connections = d.connections.filter((c) => c.id !== sel.id);
  });
  setUI({ selection: null });
}

function Editor() {
  const world = useWorld();
  const ui = useUI();
  const fileRef = useRef<HTMLInputElement>(null);
  const rhRef = useRef<HTMLInputElement>(null);
  const left = usePanel('left', 220);
  const right = usePanel('right', 360);
  const panels = useRef({ left, right });
  panels.current = { left, right };
  const map = findMap(world, ui.mapId) ?? world.maps[0];

  useEffect(() => { if (map && map.id !== ui.mapId) setUI({ mapId: map.id }); }, [map, ui.mapId]);
  useEffect(() => { autoLoadFromLauncher(); checkDiskTarget(); }, []);
  useEffect(() => { broadcastWorld(world); }, [world]);
  // 切地图时，自动切到关联这张图的流程图
  useEffect(() => {
    const f = getWorld().flows.find((x) => x.mapId === ui.mapId);
    if (f) setUI({ flowId: f.id });
  }, [ui.mapId]);
  useEffect(() => {
    return listenAsEditor(() => send({ type: 'world', world: getWorld() }));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input,textarea,select');
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault();
        e.shiftKey ? redo() : undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y' && !typing) { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!getUI().trial) saveToDisk(); return; }
      if (typing || mod) return;
      if (getUI().trial) {
        const k = e.key.toLowerCase();
        const dir: Record<string, [number, number]> = { w: [0, -1], a: [-1, 0], s: [0, 1], d: [1, 0] };
        if (dir[k]) { e.preventDefault(); trialMove(...dir[k]); }
        else if (e.key === ' ') { e.preventDefault(); trialEndTurn(); }
        else if (e.key === 'Tab') { e.preventDefault(); switchTrialPlayer(); }
        else if (k === 'g') { e.preventDefault(); toggleMarkMode(); }
        else if (e.key === 'Escape') { if (getUI().trial?.markMode) toggleMarkMode(false); else endTrial(); }
        return;
      }
      if (e.key === '[') { const p = panels.current.left; p.setOpen(!p.open); return; }
      if (e.key === ']') { const p = panels.current.right; p.setOpen(!p.open); return; }
      if (e.key === 'Escape') setUI({ pendingConn: null, selection: null, tool: 'select' });
      else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelection();
      else if (TOOL_KEYS[e.key.toLowerCase()]) {
        const t = TOOL_KEYS[e.key.toLowerCase()];
        if (!toolsFor(getUI()).includes(t)) return;
        setUI({ tool: t, pendingConn: null });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!map) return null;
  const run = ui.mode === 'run';
  const playerMap = findMap(world, world.playerMapId ?? '');

  return (
    <div className={`app mode-${ui.mode}`}>
      <header className="topbar">
        <input className="world-name" value={world.name} onChange={(e) => update((d) => { d.name = e.target.value; }, { coalesce: 'wname' })} />
        <div className="seg">
          {MODES.map((m) => (
            <button key={m.mode} className={ui.mode === m.mode ? 'on' : ''}
              onClick={() => ui.mode !== m.mode && setUI({ mode: m.mode, tool: 'select', tab: m.tab, pendingConn: null, unlock: false })}>{m.label}</button>
          ))}
        </div>
        {run && <span className="session">第 {world.session} 场</span>}
        {ui.mode !== 'edit' && (
          <button className={ui.unlock ? 'unlock on' : 'unlock'} title="兜底：临时允许修改上一级的内容"
            onClick={() => setUI({ unlock: !ui.unlock, tool: 'select' })}>
            {ui.unlock ? '🔓 已解锁编辑' : `🔒 ${ui.mode === 'prep' ? '地图' : '地图和预测'}只读`}
          </button>
        )}
        <span className="spacer" />
        <span className="muted">玩家看到：{playerMap ? `${playerMap.layer}·${playerMap.name}` : '（没推送）'}</span>
        {map.id !== world.playerMapId && <button onClick={() => update((d) => { d.playerMapId = map.id; })}>推送当前地图</button>}
        <button className={ui.trial ? 'trial-btn on' : 'trial-btn'} onClick={() => (ui.trial ? endTrial() : startTrial())}>{ui.trial ? '■ 结束试玩' : '▶ 试玩'}</button>
        <select aria-label="打开绑定角色的玩家窗口" value="" onChange={e => { if (e.target.value) openPlayerWindow(e.target.value); }}>
          <option value="">打开玩家窗口…</option>{world.party.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <button title="撤销 ⌘Z" onClick={undo}>↶</button>
        <button title="重做 ⇧⌘Z" onClick={redo}>↷</button>
        <details className="menu">
          <summary>文件</summary>
          <div className="menu-body" onClick={(e) => (e.currentTarget.parentElement as HTMLDetailsElement).open = false}>
            {ui.diskTarget && <button onClick={saveToDisk} title={ui.diskTarget}>保存回文件（⌘S）</button>}
            <button onClick={exportProject}>导出工程（.zip，含媒体）</button>
            <button onClick={() => fileRef.current?.click()}>导入工程…</button>
            <button onClick={() => confirm('导入 Rabbithole 地图会替换当前内容，当前内容请先导出。继续？') && rhRef.current?.click()}>导入 Rabbithole 地图（.zip / .json）…</button>
            <button onClick={() => startFreshWorld(emptyWorld(), '新建空白世界')}>新建空白世界</button>
            <button onClick={() => startFreshWorld(demoWorld(), '载入示例数据')}>载入示例</button>
            {hasBackup() && <button onClick={() => confirm('换回上一次导入前的内容？（现在的内容会存成备份，可以再换回来）') && restoreBackup()}>恢复导入前的内容</button>}
            <div className="menu-ver">奇点之后 · 地图编辑器 v{__APP_VERSION__}</div>
          </div>
        </details>
        <input ref={rhRef} type="file" accept=".zip,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importAnyFile(f); e.target.value = ''; }} />
        <input ref={fileRef} type="file" accept=".zip,.json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) importAnyFile(f); e.target.value = ''; }} />
      </header>

      {!storageOK && <div className="storage-warn">这个浏览器不让本页保存数据（无痕模式或用某些浏览器直接打开本地文件时会这样）。关掉之前请用「文件 → 导出工程」保存。推荐用 Chrome 或 Edge 打开。</div>}
      <div className="main">
        {left.open && <div className="side-wrap" style={{ width: left.width }}><Sidebar /></div>}
        <Splitter side="left" panel={left} max={480} />
        <div className="center">
          <div className="map-area">
            {(() => {
              const tr = ui.trial && ui.trial.mapId === map.id ? ui.trial : null;
              const cur = tr?.players[tr.current];
              return <MapCanvas world={world} map={map} mode={tr ? 'player' : ui.mode} follow={cur?.tokenId} viewer={cur?.pcId} onCellClick={tr ? trialClick : undefined} cursor={tr?.markMode ? 'crosshair' : undefined} />;
            })()}
            <TrialHud />
            <div className="map-badge">{map.layer} · F{map.floor} · {map.name}　<span className="muted">{map.width}×{map.height}</span></div>
            <button className="fit-btn" title="把整张图缩放到可见范围" onClick={() => setUI((st) => { const v = { ...st.views }; delete v[map.id]; return { views: v }; })}>⤢ 适配</button>
            {ui.pendingConn && <div className="banner">正在连线：起点在「{findMap(world, ui.pendingConn.mapId)?.name}」{cellName(ui.pendingConn.x, ui.pendingConn.y)}，点终点（可以先切到别的地图），Esc 取消</div>}
            <div className="help">滚轮缩放 · 空格+拖动 / 右键拖动 平移 · 双击连接点跳转</div>
            <MediaDock />
        
          </div>
          {ui.mode !== 'edit' && <FlowPanel />}
        </div>
        <Splitter side="right" panel={right} />
        {right.open && <aside className="right" style={{ width: right.width }}>
          <nav className="tabs">
            {TABS[ui.mode].map(([k, l]) => (
              <button key={k} className={ui.tab === k ? 'on' : ''} onClick={() => setUI({ tab: k })}>{l}</button>
            ))}
          </nav>
          <div className="tab-body">
            {ui.tab === 'inspect' && <Inspector />}
            {ui.tab === 'log' && ui.mode === 'run' && <RecordPanel />}
            {ui.tab === 'party' && ui.mode !== 'edit' && <PartyPanel />}
            {ui.tab === 'npc' && ui.mode !== 'edit' && <NpcPanel />}
            {ui.tab === 'media' && <MediaPanel />}
          </div>
        </aside>}
      </div>

      {ui.privateNote && (
        <div className="modal-bg" onClick={() => setUI({ privateNote: null })}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">私密给 {ui.privateNote.to || '（没选人）'}</div>
            <div className="muted">{ui.privateNote.title}</div>
            <p className="modal-text">{ui.privateNote.text}</p>
            <div className="btns">
              <button onClick={() => navigator.clipboard.writeText(ui.privateNote!.text)}>复制文字</button>
              <button onClick={() => setUI({ privateNote: null })}>关闭</button>
            </div>
            <div className="hint">第一阶段还没联网，私密信息请复制后私聊发给这位玩家。</div>
          </div>
        </div>
      )}
      {ui.toast && <div className="toast">{ui.toast}</div>}
    </div>
  );
}

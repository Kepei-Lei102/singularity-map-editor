import { useEffect, useState } from 'react';
import { useWorld } from '../core/store';
import { closeOnlineHostRoom, createOnlineHostRoom, inviteOnlinePlayer, onOnlineHostClosed, onlineHostInfo } from '../runtime/onlineRoom';

/**
 * 线上房间入口：主持端开房、给每个角色发一次性邀请链接。
 * 本地窗口按钮仍然保留；线上时点它会提示改用这里的链接。
 */
export function OnlinePanel() {
  const world = useWorld();
  const [roomId, setRoomId] = useState<string | null>(() => onlineHostInfo()?.roomId ?? null);
  const [link, setLink] = useState<{ pcId: string; name: string; url: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => onOnlineHostClosed((reason) => {
    setRoomId(null); setLink(null); setErr(`房间已关闭：${reason}`);
  }), []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setErr(null);
    try { await fn(); } catch (e) { setErr(e instanceof Error ? e.message : '操作失败'); }
    finally { setBusy(false); }
  };

  const open = () => run(async () => {
    const r = await createOnlineHostRoom();
    setRoomId(r.roomId);
  });
  const invite = (pcId: string, name: string) => run(async () => {
    const url = await inviteOnlinePlayer(pcId);
    setLink({ pcId, name, url });
  });
  const close = () => run(async () => {
    await closeOnlineHostRoom();
    setRoomId(null); setLink(null);
  });
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setErr('已复制'); } catch { setErr('复制失败，请手动选中链接'); }
  };

  return <details className="menu">
    <summary>{roomId ? '线上房间 · 已开' : '线上房间'}</summary>
    <div className="menu-body">
      {!roomId ? <>
        <button disabled={busy} onClick={open}>{busy ? '正在建房…' : '开一个线上房间'}</button>
        <div className="menu-ver">需要先运行 <code>npm run server</code>；本地的「打开玩家窗口」不受影响。</div>
      </> : <>
        <div className="menu-ver">房间号：<b>{roomId}</b></div>
        <div className="menu-ver">给每个角色发一张一次性邀请；玩家打开链接就进这个房间。</div>
        {(world.party.length ? world.party : []).map((p) => <button key={p.id} disabled={busy} onClick={() => invite(p.id, p.name)}>
          生成 {p.name} 的邀请链接
        </button>)}
        {!world.party.length && <div className="menu-ver">队伍里还没有角色。</div>}
        {link && <div className="online-link">
          <input readOnly value={link.url} />
          <button className="small" onClick={copy}>复制</button>
        </div>}
        {err && <div className="menu-ver">{err}</div>}
        <button disabled={busy} onClick={close}>关房，切回本地窗口</button>
      </>}
      {!roomId && err && <div className="menu-ver">{err}</div>}
    </div>
  </details>;
}

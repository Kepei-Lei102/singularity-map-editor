import { useEffect, useState } from 'react';
import { listen, send } from '../sync';
import type { World } from '../types';
import { TIER_LABEL } from '../types';
import { MapCanvas } from './MapCanvas';
import { MediaView } from './MediaPanel';

/** 玩家窗口：主持人共享这个窗口的屏幕给玩家。只显示玩家该看到的东西。 */
export function PlayerView() {
  const [world, setWorld] = useState<World | null>(null);
  const [media, setMedia] = useState<{ mediaId: string; label: string; mime: string; blob?: Blob } | null>(null);
  const [armed, setArmed] = useState(false);
  const [nums, setNums] = useState(false);
  const [viewer, setViewer] = useState('');

  useEffect(() => {
    const off = listen((m) => {
      if (m.type === 'world') setWorld(m.world);
      else if (m.type === 'play') setMedia({ mediaId: m.mediaId, label: m.label, mime: m.mime, blob: m.blob });
      else if (m.type === 'stop') setMedia(null);
    });
    send({ type: 'hello' });
    document.title = '奇点之后 · 玩家视角';
    return off;
  }, []);

  const map = world?.maps.find((m) => m.id === world.playerMapId);
  const clues = (world?.maps ?? [])
    .flatMap((m) => m.objects.flatMap((o) =>
      o.secrets.filter((s) => s.revealed?.scope === 'party').map((s) => ({ o, s }))))
    .sort((a, b) => b.s.revealed!.at - a.s.revealed!.at);

  return (
    <div className="player">
      {map ? <MapCanvas world={world!} map={map} mode="player" playerNumbers={nums} viewer={viewer || undefined} /> : <div className="player-wait">等待主持人推送地图……</div>}
      {map && <div className="player-title">{map.layer} · {map.name}</div>}
      {map && <button className="player-nums" onClick={() => setNums(!nums)}>{nums ? '隐藏编号' : '显示编号'}</button>}
      {map && world!.visionMode === 'individual' && (
        <select className="player-viewer" value={viewer} onChange={(e) => setViewer(e.target.value)}>
          <option value="">（全队合起来）</option>
          {world!.party.map((p) => <option key={p.id} value={p.id}>{p.name} 的视角</option>)}
        </select>
      )}
      {clues.length > 0 && (
        <div className="clues">
          <div className="clues-title">线索</div>
          {clues.map(({ o, s }) => (
            <div key={s.id} className="clue">
              <b>{o.name}·{s.label}</b> <span className="muted">{s.kind === 'auto' ? '看到' : `${s.check}${TIER_LABEL[s.revealed!.tier]}`}</span>
              <div>{s.tiers[s.revealed!.tier]}</div>
            </div>
          ))}
        </div>
      )}
      {media && armed && (
        <div className={media.mime.startsWith('audio') ? 'player-audio' : 'player-media'}>
          {media.mime.startsWith('audio') && <span>♪ {media.label}</span>}
          <MediaView key={media.mediaId} mediaId={media.mediaId} blob={media.blob} mime={media.mime} autoPlay
            onEnded={() => !media.mime.startsWith('image') && setMedia(null)} />
        </div>
      )}
      {!armed && (
        <div className="arm" onClick={() => setArmed(true)}>
          <div>点一下这里开始</div>
          <div className="muted">（浏览器要先点一下才允许自动播放声音）</div>
        </div>
      )}
    </div>
  );
}

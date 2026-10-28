import { useEffect, useState } from 'react';
import { listenAsPlayer } from '../sync';
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

  useEffect(() => {
    const off = listenAsPlayer((m) => {
      if (m.type === 'world') setWorld(m.world);
      else if (m.type === 'clear') { setWorld(null); setMedia(null); }
      else if (m.type === 'play') setMedia({ mediaId: m.mediaId, label: m.label, mime: m.mime, blob: m.blob });
      else if (m.type === 'stop') setMedia(null);
    });
    document.title = '奇点之后 · 玩家视角';
    return off;
  }, []);

  const map = world?.maps.find((m) => m.id === world.playerMapId);
  const clues = [...(world?.clues ?? [])].sort((a, b) => b.at - a.at); // 公开过的线索单独带来，物件看不见了也还在

  return (
    <div className="player">
      {map ? <MapCanvas world={world!} map={map} mode="player" playerNumbers={nums} viewer={undefined} /> : <div className="player-wait">等待主持人推送地图……</div>}
      {map && <div className="player-title">{map.layer} · {map.name}</div>}
      {map && <button className="player-nums" onClick={() => setNums(!nums)}>{nums ? '隐藏编号' : '显示编号'}</button>}
      {map && <span className="player-viewer">{world!.party[0]?.name} 的视角</span>}
      {clues.length > 0 && (
        <div className="clues">
          <div className="clues-title">线索</div>
          {clues.map((c) => (
            <div key={c.id} className="clue">
              <b>{c.object}·{c.label}</b> <span className="muted">{c.kind === 'auto' ? '看到' : `${c.check}${TIER_LABEL[c.tier]}`}</span>
              <div>{c.text}</div>
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

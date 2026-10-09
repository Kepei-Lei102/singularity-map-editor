import { stopMedia, playMedia } from '../actions';
import { delBlob, putBlob, useBlobUrl } from '../media';
import { toast, update, useUI, useWorld } from '../store';
import { uid } from '../util';
import { Section } from './fields';

const kindOf = (mime: string) => (mime.startsWith('video') ? '视频' : mime.startsWith('audio') ? '音频' : mime.startsWith('image') ? '图片' : '文件');

export function MediaPanel() {
  const w = useWorld();
  const upload = async (files: FileList | null) => {
    if (!files) return;
    for (const f of Array.from(files)) {
      const id = uid();
      try {
        await putBlob(id, f);
        update((d) => { d.media.push({ id, name: f.name, mime: f.type || 'application/octet-stream', size: f.size }); });
      } catch (e) {
        toast(`上传失败：${f.name}`);
      }
    }
  };
  return (
    <Section title="媒体库">
      <div className="hint">文件存在这台电脑的浏览器里。换电脑请用「导出工程」打包带走。</div>
      <label className="upload">
        上传音频 / 视频 / 图片
        <input type="file" multiple accept="audio/*,video/*,image/*" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {w.media.map((m) => (
        <div key={m.id} className="list-row">
          <span>{kindOf(m.mime)} · {m.name} <span className="muted">{(m.size / 1048576).toFixed(1)}MB</span></span>
          <span className="inline">
            <button className="small" title="只在主持人这边播放" onClick={() => playMedia(m.id, m.name, false)}>▶</button>
            <button className="small" title="同步给玩家窗口" onClick={() => playMedia(m.id, m.name, true)}>📡</button>
            <button className="danger small" onClick={() => {
              if (!confirm(`删除「${m.name}」？挂在物件上的引用也会一起删掉。`)) return;
              delBlob(m.id);
              update((d) => {
                d.media = d.media.filter((x) => x.id !== m.id);
                d.maps.forEach((mp) => mp.objects.forEach((o) => { o.media = o.media.filter((a) => a.mediaId !== m.id); }));
              });
            }}>×</button>
          </span>
        </div>
      ))}
    </Section>
  );
}

export function MediaView({ mediaId, blob, mime, autoPlay, onEnded }: { mediaId: string; blob?: Blob; mime: string; autoPlay: boolean; onEnded?: () => void }) {
  const url = useBlobUrl(mediaId, blob);
  if (!url) return <div className="muted">载入中…</div>;
  if (mime.startsWith('video')) return <video src={url} controls autoPlay={autoPlay} onEnded={onEnded} />;
  if (mime.startsWith('audio')) return <audio src={url} controls autoPlay={autoPlay} onEnded={onEnded} />;
  if (mime.startsWith('image')) return <img src={url} />;
  return <a href={url} target="_blank">打开文件</a>;
}

/** 主持人这边正在播放的媒体。 */
export function MediaDock() {
  const ui = useUI();
  const w = useWorld();
  const np = ui.nowPlaying;
  if (!np) return null;
  const meta = w.media.find((m) => m.id === np.mediaId);
  if (!meta) return null;
  return (
    <div className="dock">
      <div className="dock-head">
        <span>{np.broadcast ? '📡 玩家也在看/听　' : '▶ 仅主持人　'}{np.label || meta.name}</span>
        <button className="small" onClick={stopMedia}>{np.broadcast ? '停止（玩家也停）' : '关闭'}</button>
      </div>
      {/* 同步给玩家时主持人这边静音，避免共享屏幕时声音叠两遍 */}
      <MediaView key={np.mediaId + np.broadcast} mediaId={np.mediaId} mime={meta.mime} autoPlay={!np.broadcast} />
    </div>
  );
}

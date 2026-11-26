import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { cleanupMedia, deleteMedia, offerDeleteOrphanBlob, stopMedia, playMedia } from '../runtime/actions';
import { assetTransferStats, isOnlineTransport, subscribeAssetTransferStats, subscribeTransportKind, type AssetTransferStats } from '../runtime/sync';
import { storeBlobStatus, useBlobUrl } from '../runtime/media';
import { toast, update, useUI, useWorld, worldContext } from '../core/store';
import { uid } from '../core/util';
import { Section } from './fields';

const isPdf = (mime: string) => mime === 'application/pdf';
const fmtBytes = (n: number) => n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${Math.round(n)} B`;
const kindOf = (mime: string) => (mime.startsWith('video') ? '视频' : mime.startsWith('audio') ? '音频' : mime.startsWith('image') ? '图片' : isPdf(mime) ? 'PDF' : '文件');

/** 图片媒体的缩略图。加载中、文件不在本机或解码失败时都留一个固定尺寸的省略槽。 */
function MediaThumb({ id }: { id: string }) {
  const [failed, setFailed] = useState(false);
  const url = useBlobUrl(id);
  // 文件被导入/恢复换掉后 URL 会变；这时清掉上一次的失败，不然缩略图会一直空着。
  useEffect(() => { setFailed(false); }, [id, url]);
  if (failed || !url) return <span className="media-thumb media-thumb-empty" title={failed ? '文件读不出来' : '文件不在本机，或还没读完'} aria-hidden="true" />;
  return <img className="media-thumb" src={url} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

export function MediaPanel() {
  const w = useWorld();
  const online = useSyncExternalStore(subscribeTransportKind, isOnlineTransport, isOnlineTransport);
  const upload = async (files: FileList | null) => {
    if (!files) return;
    const ctx = worldContext(); // 上传途中换了工程、进出了试玩：传完的文件不挂到那时恰好打开的世界上
    for (const f of Array.from(files)) {
      const id = uid();
      let stored: { key: string; created: boolean } | null = null;
      try {
        // 有的系统给 PDF 的类型是空的，按扩展名补上
        const mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : 'application/octet-stream');
        stored = await storeBlobStatus(mime === f.type ? f : new Blob([f], { type: mime })); // 存成新文件（不覆盖任何已有的）
        if (ctx !== worldContext()) {
          toast(`「${f.name}」传完时工程已经换了（或试玩开始 / 结束了），没有加进去`);
          await offerDeleteOrphanBlob(f.name, stored);
          return;
        }
        update((d) => { d.media.push({ id, name: f.name, mime, size: f.size, key: stored!.key }); });
      } catch (e) {
        if (stored) await offerDeleteOrphanBlob(f.name, stored);
        toast(`上传失败：${f.name}`);
      }
    }
  };
  return (
    <Section title="媒体库">
      <div className="hint">文件存在这台电脑的浏览器里。换电脑请用「文件 → 导出成 zip」打包带走。</div>
      <button className="small" title="删掉浏览器里没有任何工程、存档、备份用到的旧文件" onClick={() => cleanupMedia()}>清理用不到的文件</button>
      <label className="upload">
        上传音频 / 视频 / 图片 / PDF
        <input type="file" multiple accept="audio/*,video/*,image/*,application/pdf,.pdf" onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </label>
      {w.media.map((m) => (
        <div key={m.id} className="list-row">
          <span className="media-meta">
            {m.mime.startsWith('image/') && <MediaThumb id={m.id} />}
            <span className="media-meta-text" title={m.name}>{kindOf(m.mime)} · {m.name} <span className="muted">{(m.size / 1048576).toFixed(1)}MB</span></span>
          </span>
          <span className="inline">
            <button className="small" title="只在主持人这边播放" onClick={() => playMedia(m.id, m.name, false)}>▶</button>
            <button className="small" title={online ? '同步给玩家（线上会分块传文件）' : '同步给玩家窗口'} onClick={() => playMedia(m.id, m.name, true)}>📡</button>
            <button className="danger small" onClick={() => {
              if (!confirm(`删除「${m.name}」？挂在物件上的引用也会一起删掉。`)) return;
              // 文件本身先不删：撤销、试玩结束恢复时还要用到。浏览器里多留一份不碍事，导出的工程只带还在用的。
              deleteMedia(m.id);
            }}>×</button>
          </span>
        </div>
      ))}
    </Section>
  );
}

export type MediaProgress = { received: number; total?: number };

/** 进度文字只在总大小已知时给百分比；未知时还是普通的「载入中…」。 */
export function mediaProgressText(progress?: MediaProgress): string {
  if (!progress || !progress.total || progress.total <= 0) return '载入中…';
  const pct = Math.max(0, Math.min(100, Math.floor((progress.received / progress.total) * 100)));
  return `载入中… ${pct}%`;
}

export function MediaView({ mediaId, blob, mime, autoPlay, onEnded, progress }: { mediaId: string; blob?: Blob; mime: string; autoPlay: boolean; onEnded?: () => void; progress?: MediaProgress }) {
  const url = useBlobUrl(mediaId, blob);
  if (!url) return <div className="muted">{mediaProgressText(progress)}</div>;
  if (mime.startsWith('video')) return <video src={url} controls autoPlay={autoPlay} onEnded={onEnded} />;
  if (mime.startsWith('audio')) return <audio src={url} controls autoPlay={autoPlay} onEnded={onEnded} />;
  if (mime.startsWith('image')) return <img src={url} />;
  // PDF（比如模组里的书）：用浏览器自带的阅读器，能翻页、缩放
  if (isPdf(mime)) return <iframe className="pdf-view" src={url} title="PDF" />;
  return <a href={url} target="_blank">打开文件</a>;
}

const ASSET_STATS_UI_MS = 150;
/** 素材一块 45ms 就推一次账本；Dock 只是给人看的，150ms 合并一次，别整块重渲染。
 *  订阅/快照/间隔可注入，测试才能在没有真实线上流的情况下验证合并行为。 */
export function useThrottledAssetTransferStats(
  subscribe: (fn: () => void) => () => void = subscribeAssetTransferStats,
  snapshot: () => AssetTransferStats = assetTransferStats,
  delayMs = ASSET_STATS_UI_MS,
): AssetTransferStats {
  // subscribe/snapshot 只用来注入测试替身；生产里是模块级稳定函数，所以 effect 只跟 delayMs 重订。
  // 最新函数放 ref，在 commit 后更新，避免 render 里写 ref 被并发渲染的废弃分支污染。
  const latest = useRef({ subscribe, snapshot });
  useEffect(() => { latest.current = { subscribe, snapshot }; });
  const [stats, setStats] = useState<AssetTransferStats>(() => snapshot());
  useEffect(() => {
    let timer: number | undefined;
    const off = latest.current.subscribe(() => {
      if (timer !== undefined) return;
      timer = window.setTimeout(() => { timer = undefined; setStats(latest.current.snapshot()); }, delayMs);
    });
    return () => { off(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [delayMs]);
  return stats;
}

/** Dock 的传输明细行；单独拆出来，方便在没有真实线上流时渲染验证。 */
export function DockTransferLine({ transfer }: { transfer: AssetTransferStats }) {
  const names = transfer.bindings.length <= 3 ? transfer.bindings.map((b) => b.name || b.pcId).filter(Boolean) : [];
  return (
    <div className="dock-transfer">
      {names.length ? `正在传素材给 ${names.join('、')}（${transfer.players} 名${transfer.players > 1 ? '，共享带宽' : ''}）` : `正在传素材给 ${transfer.players} 名玩家${transfer.players > 1 ? '（共享带宽）' : ''}`}
      {transfer.totalBytes > 0 ? ` · ${fmtBytes(transfer.bytes)} / ${fmtBytes(transfer.totalBytes)}` : transfer.bytes > 0 ? ` · 已发 ${fmtBytes(transfer.bytes)}` : ''}
      {transfer.inFlight > 0 ? ` · ${transfer.inFlight} 个传输中` : ''}
      {transfer.queued > 0 ? ` · ${transfer.queued} 个排队` : ''}
      {transfer.rate > 0 ? ` · 近 2 秒 ${fmtBytes(transfer.rate)}/s` : ''}
    </div>
  );
}

/** 主持人这边正在播放的媒体。 */
export function MediaDock() {
  const ui = useUI();
  const w = useWorld();
  const transfer = useThrottledAssetTransferStats();
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
      {np.broadcast && transfer.players > 0 && <DockTransferLine transfer={transfer} />}
      {/* 同步给玩家时主持人这边静音，避免共享屏幕时声音叠两遍 */}
      <MediaView key={np.mediaId + np.broadcast} mediaId={np.mediaId} mime={meta.mime} autoPlay={!np.broadcast} />
    </div>
  );
}

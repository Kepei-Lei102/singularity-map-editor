import { useEffect, useRef, useState } from 'react';
import { toast } from '../core/store';
import { parseVault, unlockVault, vaultInfo } from '../core/vault';
import type { VaultEnvelope } from '../core/vault';

// 角色密档解锁：明文只在内存里活。关面板、切走标签页、或 3 分钟没人动，它就没。
// 注意：这里不 import update / persist，一个字都不许写进存档。

const AUTO_CLEAR_SECONDS = 180;

export function VaultPanel({ onClose }: { onClose: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [env, setEnv] = useState<VaultEnvelope | null>(null);
  const [fileName, setFileName] = useState('');
  const [pass, setPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [left, setLeft] = useState(AUTO_CLEAR_SECONDS);

  const wipe = () => { setText(''); setPass(''); };

  // 切到别的标签页就立刻清空
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') { setText(''); setPass(''); } };
    document.addEventListener('visibilitychange', onHide);
    return () => document.removeEventListener('visibilitychange', onHide);
  }, []);

  // 解开之后开始倒计时
  useEffect(() => {
    if (!text) return;
    setLeft(AUTO_CLEAR_SECONDS);
    const t = window.setInterval(() => {
      setLeft((s) => {
        if (s <= 1) { setText(''); setPass(''); return AUTO_CLEAR_SECONDS; }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [text]);

  async function pick(f: File) {
    setFileName(f.name);
    setText('');
    try {
      setEnv(parseVault(await f.text()));
    } catch (err) {
      setEnv(null);
      setFileName('');
      toast((err as Error).message);
    }
  }

  async function unlock() {
    if (!env) return toast('先选一个 .enc 密档');
    if (!pass) return toast('口令不能为空');
    setBusy(true);
    try {
      setText(await unlockVault(env, pass));
      setPass('');
    } catch (err) {
      toast((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const info = env ? vaultInfo(env) : null;

  return (
    <div className="modal-bg" onClick={() => { wipe(); onClose(); }}>
      <div className="modal vault-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">角色密档</div>
        <div className="vault-note">
          只在内存里解。关掉面板、切到别的标签页、或 3 分钟没人动，明文就没了。不写进存档，也不进 localStorage。
        </div>
        <div className="inline" style={{ marginTop: 10 }}>
          <button className="small" onClick={() => fileRef.current?.click()}>选择 .enc</button>
          <span className="muted small-text">{fileName || '未选择'}</span>
          <input ref={fileRef} type="file" accept=".enc,.json,application/json" hidden onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void pick(f);
          }} />
        </div>
        {info && <div className="muted small-text" style={{ marginTop: 6 }}>{info.cipher} · {info.kdf} · {info.bytes} B</div>}
        <div className="inline" style={{ marginTop: 10 }}>
          <input type="password" placeholder="口令" autoComplete="off" value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void unlock(); }} />
          <button className="small" disabled={busy || !env} onClick={() => void unlock()}>{busy ? '解…' : '解锁'}</button>
          {text && <button className="danger small" onClick={wipe}>立即清空</button>}
        </div>
        {text && <>
          <div className="muted small-text" style={{ marginTop: 8 }}>{left} 秒后自动清空</div>
          <pre className="vault-text">{text}</pre>
        </>}
        <div className="inline" style={{ marginTop: 12, justifyContent: 'flex-end' }}>
          <button className="small" onClick={() => { wipe(); onClose(); }}>关闭</button>
        </div>
      </div>
    </div>
  );
}

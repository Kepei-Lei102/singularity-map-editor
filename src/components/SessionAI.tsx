import { useEffect, useMemo, useRef, useState } from 'react';
import { isPlayerEntry } from '../deployment';
import { getUI, onProjectReplaced, projectContext, useUI, useWorld, worldContext } from '../store';
import {
  advisorChangeError, applyAdvisorChange, buildSessionAIContext, captureAdvisorSnapshot, CONTEXT_LIMIT,
  HISTORY_LIMIT, requestSessionAI, TURN_LIMIT,
  type AdvisorReply, type AdvisorSettings, type AdvisorSnapshot, type AdvisorTurn,
} from '../sessionAI';

interface Preview { context: string; messages: AdvisorTurn[]; snapshot: AdvisorSnapshot; settings: AdvisorSettings; prompt: string }
interface Answer { reply: AdvisorReply; snapshot: AdvisorSnapshot; applied: number[] }

/** Mount only in the host entry; keep mounted while hidden to retain the host-only conversation. */
export function SessionAI({ onClose, active = true }: { onClose?: () => void; active?: boolean }) {
  const world = useWorld();
  const ui = useUI(); // Trial start can change worldContext without replacing the world value.
  const currentContext = worldContext();
  const activeMapId = ui.mapId;
  const player = isPlayerEntry();
  const [settings, setSettings] = useState<AdvisorSettings>({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' });
  const [messages, setMessages] = useState<AdvisorTurn[]>([]);
  const [prompt, setPrompt] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const conversationContext = useRef(currentContext);

  function clear() {
    generation.current++;
    pending.current?.abort(); pending.current = null;
    if (password.current) password.current.value = '';
    setMessages([]); setPrompt(''); setPreview(null); setAnswer(null); setError(''); setBusy(false);
  }
  useEffect(() => {
    const unsubscribe = onProjectReplaced(clear);
    return () => { unsubscribe(); generation.current++; pending.current?.abort(); };
  }, []);

  useEffect(() => {
    if (conversationContext.current !== currentContext) {
      conversationContext.current = currentContext;
      clear();
    }
  }, [currentContext]);
  const context = useMemo(() => active && !player ? buildSessionAIContext(world, activeMapId) : '', [active, player, world, activeMapId]);
  const previewText = useMemo(() => active && preview ? JSON.stringify({ endpoint: preview.settings, context: JSON.parse(preview.context), messages: preview.messages }, null, 2) : '', [active, preview]);
  if (player || !active) return null;
  const historySize = JSON.stringify([...messages, { role: 'user', content: prompt.trim() }]).length;
  const overBudget = context.length > CONTEXT_LIMIT || historySize > HISTORY_LIMIT || prompt.length > TURN_LIMIT;
  const prepared = preview && preview.prompt === prompt.trim() && preview.context === context &&
    preview.snapshot.context === worldContext() && preview.snapshot.project === projectContext() &&
    JSON.stringify(preview.settings) === JSON.stringify(settings);

  function prepare() {
    setError('');
    if (!prompt.trim() || overBudget) return;
    const snapshot = captureAdvisorSnapshot();
    setPreview({ context: buildSessionAIContext(snapshot.world, getUI().mapId), messages: [...messages, { role: 'user', content: prompt.trim() }], snapshot, settings: { ...settings }, prompt: prompt.trim() });
  }
  async function send() {
    if (!prepared || !preview || busy) return;
    const snapshot = captureAdvisorSnapshot(); // Refresh for every request, including after preview.
    if (buildSessionAIContext(snapshot.world, getUI().mapId) !== preview.context || snapshot.context !== preview.snapshot.context || snapshot.project !== preview.snapshot.project) {
      setPreview(null); setError('世界已更新，请重新预览后发送'); return;
    }
    const controller = new AbortController(); pending.current = controller;
    const current = ++generation.current;
    let key = password.current?.value ?? '';
    if (password.current) password.current.value = '';
    setBusy(true); setError(''); setAnswer(null);
    try {
      const request = requestSessionAI(preview.settings, preview.context, preview.messages, key, controller.signal);
      key = '';
      const reply = await request;
      if (current !== generation.current || snapshot.project !== projectContext() || snapshot.context !== worldContext()) return;
      setMessages([...preview.messages, { role: 'assistant', content: JSON.stringify(reply) }]);
      setAnswer({ reply, snapshot, applied: [] }); setPrompt(''); setPreview(null);
    } catch (e) {
      if (current === generation.current && !controller.signal.aborted) setError(e instanceof Error ? e.message : 'AI 请求失败');
    } finally {
      key = '';
      if (current === generation.current) { setBusy(false); pending.current = null; }
    }
  }
  function apply(index: number) {
    if (!answer) return;
    const failure = applyAdvisorChange(answer.reply.changes[index], answer.snapshot);
    if (failure) { setError(failure); return; }
    setAnswer({ ...answer, applied: [...answer.applied, index] });
    setPreview(null); setError('');
  }
  function changeSettings(patch: Partial<AdvisorSettings>) { setSettings({ ...settings, ...patch }); setPreview(null); }

  return <section aria-label="主持人 AI 顾问" style={{ padding: 16, maxWidth: 840, margin: '0 auto', overflowWrap: 'anywhere' }}>
    <div className="inline" style={{ justifyContent: 'space-between' }}>
      <h2 style={{ margin: '0 0 8px' }}>主持人 AI 顾问</h2>
      {onClose && <button onClick={onClose}>收起</button>}
    </div>
    <p className="hint">根据当前模组、实际流程状态、裁定和你叙述的场外事件提供建议。每次请求重新读取世界；所有变更由你逐条审核。对话仅保留在这个主持人页面；刷新、切换工程或开始／结束试玩会清空对话并取消请求。</p>
    <fieldset disabled={busy} style={{ border: '1px solid var(--border, #777)', borderRadius: 6, padding: 12 }}>
      <legend>连接设置</legend>
      <label>API 协议 <select value={settings.protocol} onChange={e => changeSettings({ protocol: e.target.value as AdvisorSettings['protocol'] })}>
        <option value="responses">OpenAI Responses</option><option value="chat-completions">OpenAI Chat Completions</option>
      </select></label>
      <label style={{ display: 'block', marginTop: 8 }}>Base URL（如 https://api.openai.com/v1）
        <input style={{ width: '100%', boxSizing: 'border-box' }} value={settings.baseURL} onChange={e => changeSettings({ baseURL: e.target.value })} spellCheck={false} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>模型
        <input style={{ width: '100%', boxSizing: 'border-box' }} value={settings.model} onChange={e => changeSettings({ model: e.target.value })} spellCheck={false} />
      </label>
      <label style={{ display: 'block', marginTop: 8 }}>API Key（仅此次请求；留空使用启动器 OPENAI_API_KEY）
        <input ref={password} type="password" autoComplete="off" name="session-ai-request-key" style={{ width: '100%', boxSizing: 'border-box' }} />
      </label>
      <p className="hint">预览中的主持人资料和本段对话将发送到你选择的服务商。密钥只用于网关请求，不写入工程或浏览器存储。自定义端点仅允许 HTTPS，回环地址可使用 HTTP。</p>
    </fieldset>
    <div role="log" aria-label="顾问对话" style={{ maxHeight: 280, overflowY: 'auto', margin: '12px 0' }}>
      {messages.map((m, i) => <div key={i} style={{ whiteSpace: 'pre-wrap', marginBottom: 10 }}>
        <strong>{m.role === 'user' ? '主持人' : '顾问'}：</strong>{m.role === 'assistant' ? (() => { try { return (JSON.parse(m.content) as AdvisorReply).message; } catch { return m.content; } })() : m.content}
      </div>)}
    </div>
    {answer && <div aria-label="待审核建议">
      <h3>待审核建议 · {answer.reply.changes.length} 条</h3>
      {answer.reply.changes.length === 0 && <p className="hint">这次没有建议改变物件或人物状态。</p>}
      {answer.reply.changes.map((c, i) => {
        const map = answer.snapshot.world.maps.find(m => m.id === c.mapId);
        const obj = c.kind === 'object-state' ? map?.objects.find(o => o.id === c.objectId) : undefined;
        const token = c.kind === 'token-status' ? map?.tokens.find(t => t.id === c.tokenId) : undefined;
        const applied = answer.applied.includes(i), why = applied ? null : advisorChangeError(c, answer.snapshot);
        const before = c.kind === 'object-state' ? obj?.states[c.fromState] ?? String(c.fromState) : c.fromStatus?.label ?? '无状态';
        const after = c.kind === 'object-state' ? obj?.states[c.toState] ?? String(c.toState) : c.status ? `${c.status.label}${c.status.roundsLeft ? ` · ${c.status.roundsLeft} 回合` : c.status.endsAt ? ` · 至 ${new Date(c.status.endsAt).toLocaleString()}` : ''}` : '解除状态';
        return <article key={i} style={{ borderBottom: '1px solid var(--border, #777)', padding: '10px 0' }}>
          <strong>{map?.name ?? c.mapId} / {obj?.name ?? token?.name ?? (c.kind === 'object-state' ? c.objectId : c.tokenId)}</strong>
          <div>{before} → {after}</div><p style={{ whiteSpace: 'pre-wrap' }}>{c.reason}</p>
          <button disabled={busy || applied || !!why} onClick={() => apply(i)}>{applied ? '已应用' : '审核后应用此条'}</button>
          {why && <p className="hint">{why}</p>}
        </article>;
      })}
    </div>}
    <label style={{ display: 'block', marginTop: 16 }}>这次发生了什么，或需要顾问考虑什么？
      <textarea rows={5} maxLength={TURN_LIMIT} value={prompt} disabled={busy} onChange={e => { setPrompt(e.target.value); setPreview(null); }} style={{ display: 'block', width: '100%', boxSizing: 'border-box' }} placeholder="例如：玩家说服守卫离开了入口，现在有哪些物件或人物状态需要我确认？" />
    </label>
    <p className="hint">世界 {context.length.toLocaleString()} / {CONTEXT_LIMIT.toLocaleString()} 字符；对话 {historySize.toLocaleString()} / {HISTORY_LIMIT.toLocaleString()} 字符；本条 {prompt.length} / {TURN_LIMIT} 字符。字符预算不是模型 token 数，超限会阻止发送。</p>
    {overBudget && <p role="alert">超过上下文预算。请缩小工程或清空对话后再发送；当前资料没有被截断。</p>}
    <div className="btns">
      <button disabled={busy || !prompt.trim() || overBudget} onClick={prepare}>预览本次上下文</button>
      <button disabled={busy || !prepared || overBudget} onClick={send}>{busy ? '顾问思考中…' : '确认预览并发送'}</button>
      {busy && <button onClick={() => { generation.current++; pending.current?.abort(); pending.current = null; setBusy(false); setError('请求已取消'); }}>取消请求</button>}
      <button onClick={clear}>清空对话</button>
    </div>
    {preview && <div style={{ marginTop: 12 }}>
      <p>{prepared ? '将发送以下最新世界快照、完整对话和本次叙述。确认后点击发送。' : '世界或设置已更新，请重新预览。'}</p>
      <pre aria-label="本次发送预览" style={{ whiteSpace: 'pre-wrap', maxHeight: 320, overflowY: 'auto', border: '1px solid var(--border, #777)', padding: 12 }}>{previewText}</pre>
    </div>}
    {error && <p role="alert" style={{ whiteSpace: 'pre-wrap' }}>{error}</p>}
  </section>;
}

// 前端那层的行为，用真实 HTTP 端点来验，不打包 sessionAI。
// sessionAI 是浏览器模块，在 Node 里加载要伪造 location/fetch，而且 esbuild 打包后
// 进程不退（会挂住套件）。这里改成直接打网关端点，验的是同一件事：
// 只认白卡 10 个名字、失败不抛、开关关掉就不连。
//
// 跑法：node --test scripts/ai-intent-fe.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mountAIGateway } from './ai-gateway.mjs';

const TOKEN = 'T'.repeat(32);
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

/** 白卡那 10 个名字，前端只认这些。 */
const TALK_ACTIONS = new Set(['【攀谈】', '【私聊】', '【喊话】', '【示意】', '【倾听】', '【对线】', '【求助】', '【微笑】', '【拥抱】', '【亲吻】']);

/**
 * 前端那一层要做的事：拿 token、问意图、挡掉编造的名字、出错不抛。
 * 这里用真 HTTP 打一遍，逻辑跟 src/runtime/sessionAI.ts 里一致。
 */
async function askIntent(origin, text, { enabled = true, fetchImpl = fetch } = {}) {
  if (!enabled) return { error: '意图匹配已关闭' };
  try {
    // 浏览器会自动带 Origin，网关的 bootstrapOK 就靠它认人
    const boot = await fetchImpl(origin + '/__ai-session', { credentials: 'same-origin', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' } });
    if (!boot.ok) return { error: '没有本机 AI 网关' };
    const { token } = await boot.json();
    if (typeof token !== 'string' || !token) return { error: '网关会话无效' };
    const res = await fetchImpl(origin + '/__ai-intent', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', 'X-AI-Token': token, Origin: origin, 'Sec-Fetch-Site': 'same-origin' },
      body: JSON.stringify({ protocol: 'chat-completions', baseURL: 'https://api.example.com/v1', model: 'm', text, apiKey: 'k' }),
    });
    const data = await res.json();
    if (!res.ok) return { error: typeof data.error === 'string' ? data.error : '网关请求失败' };
    const action = data.action === null ? null : typeof data.action === 'string' ? data.action : undefined;
    if (action === undefined) return { error: '网关没给出 action' };
    if (action !== null && !TALK_ACTIONS.has(action)) return { action: null }; // 编造的名字当没猜出来
    return { action };
  } catch (e) {
    return { error: e instanceof Error ? e.message : '连不上网关' };
  }
}

async function gateway(t, fetchImpl) {
  let handler;
  mountAIGateway({ use(fn) { handler = fn; } }, { token: TOKEN, env: {}, sameOrigin: () => true, fetchImpl });
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  return `http://127.0.0.1:${server.address().port}`;
}

const reply = (content) => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] });

test('模型猜出来的合法动作，前端认', async (t) => {
  const origin = await gateway(t, async () => reply('{"action":"【微笑】"}'));
  assert.deepEqual(await askIntent(origin, '我冲他笑了笑'), { action: '【微笑】' });
});

test('模型说不是交流，前端也认 null', async (t) => {
  const origin = await gateway(t, async () => reply('{"action":null}'));
  assert.deepEqual(await askIntent(origin, '推开门走出去'), { action: null });
});

test('模型编了个不存在的名字，前端当没猜出来', async (t) => {
  const origin = await gateway(t, async () => reply('{"action":"【胡说八道】"}'));
  assert.deepEqual(await askIntent(origin, '随便说句'), { action: null });
});

test('开关关掉就一次都不连', async () => {
  let calls = 0;
  const r = await askIntent('http://127.0.0.1:1', '我笑了笑', { enabled: false, fetchImpl: async () => { calls++; return jsonResponse({}); } });
  assert.match(r.error ?? '', /关闭/);
  assert.equal(calls, 0);
});

test('网关连不上时报错，不抛', async () => {
  const r = await askIntent('http://127.0.0.1:1', '我笑了笑', { fetchImpl: async () => { throw new Error('连不上'); } });
  assert.match(r.error ?? '', /连不上/);
});

test('网关返回错误状态时，把错误说明带出来', async (t) => {
  const origin = await gateway(t, async () => reply('{"action":"【微笑】"}'));
  // 手动打一次错的
  const r = await fetch(origin + '/__ai-intent', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-AI-Token': 'wrong' },
    body: JSON.stringify({ protocol: 'chat-completions', baseURL: 'https://api.example.com/v1', model: 'm', text: 'x', apiKey: 'k' }),
  });
  assert.equal(r.status, 403);
});

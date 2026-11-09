import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import { mountAIGateway, intentRequest, INTENT_SYSTEM, advisorEndpoint } from './ai-gateway.mjs';

const TOKEN = 'T'.repeat(32);
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

async function intentGateway(t, opts = {}) {
  let handler;
  mountAIGateway({ use(fn) { handler = fn; } }, { token: TOKEN, env: {}, ...opts });
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (payload, headers = {}) => fetch(origin + '/__ai-intent', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json', 'X-AI-Token': TOKEN, ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { origin, send };
}

const payload = (over = {}) => ({ protocol: 'chat-completions', baseURL: 'https://api.example.com/v1', model: 'm', text: '我冲他笑了笑', apiKey: 'k', ...over });
const chatReply = (content) => jsonResponse({ choices: [{ finish_reason: 'stop', message: { content } }] });
const respReply = (content) => jsonResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: content }] }] });

test('意图端点返回 action，跟顾问走同一套鉴权', async (t) => {
  const captured = [];
  const { send } = await intentGateway(t, {
    fetchImpl: async (url, opts) => { captured.push({ url, body: JSON.parse(opts.body) }); return chatReply('{"action":"【微笑】"}'); },
  });
  const res = await send(payload());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { action: '【微笑】' });
  assert.ok(captured[0].url.endsWith('/chat/completions'));
  // 用的是意图提示词，不是顾问那套
  assert.equal(captured[0].body.messages[0].content, INTENT_SYSTEM);
  assert.equal(captured[0].body.messages[0].content.includes('changes'), false, '不该混进顾问的结构要求');
  assert.equal(captured[0].body.temperature, 0, '意图匹配要稳定');
});

test('两种协议都能用', async (t) => {
  const { send } = await intentGateway(t, {
    fetchImpl: async (url) => url.endsWith('/responses') ? respReply('{"action":"【对线】"}') : chatReply('{"action":"【对线】"}'),
  });
  for (const protocol of ['responses', 'chat-completions']) {
    assert.deepEqual(await (await send(payload({ protocol }))).json(), { action: '【对线】' });
  }
});

test('不是交流的话，模型答 null 也能过', async (t) => {
  const { send } = await intentGateway(t, { fetchImpl: async () => chatReply('{"action":null}') });
  assert.deepEqual(await (await send(payload({ text: '我推开门走出去' }))).json(), { action: null });
});

test('没带 token 或跨源打不进来', async (t) => {
  const { send, origin } = await intentGateway(t, { fetchImpl: async () => chatReply('{"action":"【微笑】"}') });
  assert.equal((await send(payload(), { 'X-AI-Token': 'wrong' })).status, 403);
  assert.equal((await send(payload(), { Origin: 'http://evil.test' })).status, 403);
  assert.equal((await send(payload(), { 'X-AI-Token': '' })).status, 403);
  void origin;
});

test('字段外的东西一律拒绝，原话长度有上限', async (t) => {
  const { send } = await intentGateway(t, { fetchImpl: async () => chatReply('{"action":"【微笑】"}') });
  assert.equal((await send(payload({ extra: 1 }))).status, 400);
  assert.equal((await send(payload({ text: '' }))).status, 400);
  assert.equal((await send(payload({ text: '字'.repeat(1001) }))).status, 400);
  assert.equal((await send(payload({ baseURL: 'http://example.com/v1' }))).status, 400, '非本机端点必须 HTTPS');
  assert.equal((await send(payload({ apiKey: 'bad\nkey' }))).status, 400);
});

test('模型答得不像话时返回错误，不瞎猜', async (t) => {
  const cases = [
    '我觉得是微笑',                 // 没有 JSON
    '{"action":',                   // JSON 坏了
    '{"wrong":1}',                  // 少了 action
    '{"action":[1,2]}',             // action 不是字符串也不是 null
  ];
  for (const content of cases) {
    const { send } = await intentGateway(t, { fetchImpl: async () => chatReply(content) });
    const res = await send(payload());
    assert.equal(res.status, 502, `「${content}」应该被拒`);
    assert.ok((await res.json()).error, '要有错误说明');
  }
});

test('上游失败透传成 502，不泄露上游内容', async (t) => {
  const { send } = await intentGateway(t, { fetchImpl: async () => jsonResponse({ secret: '上游的密钥' }, 500) });
  const res = await send(payload());
  assert.equal(res.status, 502);
  const text = await res.text();
  assert.equal(text.includes('上游的密钥'), false);
});

test('intentRequest 本身也能直接调（不经 HTTP）', async () => {
  const r = await intentRequest(payload(), {
    env: {},
    fetchImpl: async () => chatReply('{"action":"【示意】"}'),
  });
  assert.deepEqual(r, { action: '【示意】' });
});

test('没给 key 也没设环境变量就报错', async () => {
  await assert.rejects(
    () => intentRequest(payload({ apiKey: undefined }), { env: {}, fetchImpl: async () => chatReply('{}') }),
    /API Key/,
  );
});

test('意图提示词里放着 10 个动作和 null 的规矩', () => {
  for (const name of ['【攀谈】', '【私聊】', '【喊话】', '【示意】', '【倾听】', '【对线】', '【求助】', '【微笑】', '【拥抱】', '【亲吻】']) {
    assert.ok(INTENT_SYSTEM.includes(name), `提示词里该有 ${name}`);
  }
  assert.ok(INTENT_SYSTEM.includes('null'), '要说明可以答 null，不然它会硬凑');
  assert.equal(INTENT_SYSTEM.includes('changes'), false);
});

test('顾问那套端点没被破坏', () => {
  assert.equal(advisorEndpoint('http://127.0.0.1:3425/v1', 'chat-completions'), 'http://127.0.0.1:3425/v1/chat/completions');
});

test('本机回环网关可以不填 key，远程端点必须填', async (t) => {
  const { send } = await intentGateway(t, { fetchImpl: async () => chatReply('{"action":"【示意】"}') });
  // 回环地址 + 空 key → 放行（magpie 这类网关信任本机）
  const loop = await send(payload({ baseURL: 'http://127.0.0.1:3425/v1', apiKey: '' }));
  assert.equal(loop.status, 200);
  assert.deepEqual(await loop.json(), { action: '【示意】' });
  // 远程地址 + 空 key → 仍然要 key
  const remote = await send(payload({ baseURL: 'https://api.example.com/v1', apiKey: '' }));
  assert.equal(remote.status, 400);
});

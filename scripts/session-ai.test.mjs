import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import http from 'node:http';
import { build } from 'esbuild';
import { advisorEndpoint, mountAIGateway } from './ai-gateway.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-session-ai-'));
await build({ stdin: { contents: `export * from './src/sessionAI'; export * from './src/defaults'; export * from './src/store'; export * from './src/actions';`, resolveDir: root }, outfile: join(temp, 'advisor.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' });
const storage = () => { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) }; };
globalThis.localStorage = storage(); globalThis.sessionStorage = storage();
globalThis.location = { search: '', origin: 'http://localhost' };
globalThis.window = { setTimeout: () => 0 };
globalThis.BroadcastChannel = class { postMessage() {} };
const api = createRequire(import.meta.url)(join(temp, 'advisor.cjs'));
after(() => rm(temp, { recursive: true, force: true }));

function fixture() {
  const world = api.emptyWorld(), map = api.newMap('门厅', '现实', 0, 10, 10, 'floor', false);
  map.autoFog = false;
  const door = { ...api.newObject('object', 2, 2, 1, 1), id: 'door', name: '入口', notes: '主持人秘密', states: ['关闭', '打开'], state: 1, stateRev: 3, blocksWhen: [0], identity: { recipients: ['pc'] } };
  map.objects = [door]; map.tokens = [{ id: 'token', pcId: 'pc', name: 'Alice', color: '#fff', x: 4, y: 4 }];
  world.maps = [map]; world.party = [{ id: 'pc', name: 'Alice', color: '#fff', tags: ['工程师'] }];
  world.flows = [{ id: 'flow', name: '追赶', mapId: map.id, nodes: [{ id: 'node', title: '已进入', x: 0, y: 0, kind: 'start', origin: 'record', status: 'happened', via: 'edge', session: 1 }], edges: [] }];
  world.judgments = [{ id: 'judgment', title: '游说', ruling: '守卫同意', session: 1 }];
  api.replaceWorld(world); api.setUI({ mode: 'run', trial: null, mapId: map.id });
  return { mapId: map.id, world: api.getWorld() };
}
const change = mapId => ({ kind: 'object-state', mapId, objectId: 'door', fromState: 1, toState: 0, reason: '主持人叙述门被关闭' });
const reply = changes => JSON.stringify({ message: '请审核建议', changes });

test('context retains stable IDs, revisions, identity, notes, actual flow status and judgments without grids', () => {
  const { world } = fixture(); const raw = api.buildSessionAIContext(world, world.maps[0].id), ctx = JSON.parse(raw);
  assert.equal(raw, JSON.stringify(ctx)); // Compact formatting changes no facts.
  assert.equal(api.CONTEXT_LIMIT, 200000);
  assert.equal(ctx.maps[0].objects[0].stateRev, 3); assert.equal(ctx.maps[0].objects[0].enabled, true);
  assert.deepEqual(ctx.maps[0].objects[0].identity, { recipients: ['pc'] });
  assert.equal(ctx.maps[0].objects[0].notes, '主持人秘密'); assert.equal(ctx.maps[0].tokens[0].status, null);
  assert.equal(ctx.flows[0].nodes[0].status, 'happened'); assert.equal(ctx.judgments[0].ruling, '守卫同意');
  assert.equal(ctx.maps[0].cells, undefined); assert.equal(ctx.maps[0].seen, undefined);
});

test('reply parser rejects code actions, prototype fields, duplicates, invalid status and malformed JSON', () => {
  const { mapId } = fixture(); const c = change(mapId);
  assert.deepEqual(api.parseSessionAIReply('```json\n' + reply([c]) + '\n```').changes, [c]);
  for (const raw of [reply([{ ...c, code: 'alert(1)' }]), reply([c, c]), reply([{ ...c, toState: '关闭' }]), reply([{ kind: 'token-status', mapId, tokenId: 'token', fromStatus: null, status: { label: '晕厥', endsAt: 123, roundsLeft: 2 }, reason: 'x' }]), '{"message":"x","changes":[],"__proto__":{}}', 'not json']) assert.throws(() => api.parseSessionAIReply(raw));
});

test('only host review applies a single change, records revision/history, and rejects replay and ABA', () => {
  const { mapId } = fixture(); const c = change(mapId), snapshot = api.captureAdvisorSnapshot();
  assert.equal(api.getWorld().maps[0].objects[0].state, 1);
  assert.equal(api.applyAdvisorChange(c, snapshot), null);
  assert.equal(api.getWorld().maps[0].objects[0].state, 0);
  assert.equal(api.getWorld().maps[0].objects[0].stateRev, 4);
  assert.match(api.applyAdvisorChange(c, snapshot), /改动/);
  api.setObjectState(mapId, 'door', 1);
  assert.match(api.applyAdvisorChange(c, snapshot), /改动/);
  api.undo(); assert.equal(api.getWorld().maps[0].objects[0].state, 0);
});

test('stale token, target re-created with identical fields, project replacement, trial and invalid target are blocked', () => {
  const { mapId } = fixture(), snapshot = api.captureAdvisorSnapshot();
  const c = { kind: 'token-status', mapId, tokenId: 'token', fromStatus: null, status: { label: '晕厥', roundsLeft: 2 }, reason: '主持人确认' };
  api.update(d => { d.maps[0].tokens[0] = { ...d.maps[0].tokens[0] }; });
  assert.match(api.applyAdvisorChange(c, snapshot), /改动/);
  assert.match(api.applyAdvisorChange({ ...change(mapId), toState: 99 }, snapshot), /不符/);
  api.replaceWorld(structuredClone(api.getWorld()));
  assert.match(api.applyAdvisorChange(change(mapId), snapshot), /切换/);
  const current = api.captureAdvisorSnapshot(); api.beginSandbox();
  assert.match(api.applyAdvisorChange(change(mapId), current), /切换/); api.endSandbox();
});

test('manual advisor review inside a trial stays sandboxed and snapshots cannot cross either transition', () => {
  const { mapId } = fixture(), real = api.getRealWorld(), beforeTrial = api.captureAdvisorSnapshot();
  api.beginSandbox();
  api.setUI({ trial: { mapId, players: [{ tokenId: 'token', pcId: 'pc', name: 'Alice' }], current: 0 } });
  try {
    assert.match(api.applyAdvisorChange(change(mapId), beforeTrial), /切换/);
    const trial = api.captureAdvisorSnapshot();
    assert.equal(api.applyAdvisorChange(change(mapId), trial), null);
    const tokenChange = { kind: 'token-status', mapId, tokenId: 'token', fromStatus: null, status: { label: '试验状态' }, reason: '只在试玩中验证' };
    assert.equal(api.applyAdvisorChange(tokenChange, trial), null);
    assert.equal(api.getWorld().maps[0].objects[0].state, 0);
    assert.equal(api.getWorld().maps[0].tokens[0].status.label, '试验状态');
    assert.equal(api.getRealWorld(), real);
    assert.equal(real.maps[0].objects[0].state, 1);
    assert.equal(real.maps[0].tokens[0].status, undefined);
    api.undo(); assert.equal(api.getWorld().maps[0].tokens[0].status, undefined);
    api.endSandbox();
    assert.equal(api.getWorld(), real);
    assert.equal(api.getWorld().maps[0].objects[0].state, 1);
    assert.match(api.applyAdvisorChange(tokenChange, trial), /切换/);
  } finally { api.endSandbox(); api.setUI({ trial: null }); }
});

test('token status additions/removals are undoable and never persist the conversation or API key', () => {
  const { mapId } = fixture(); const snapshot = api.captureAdvisorSnapshot();
  const c = { kind: 'token-status', mapId, tokenId: 'token', fromStatus: null, status: { label: '晕厥', roundsLeft: 2 }, reason: '确认' };
  assert.equal(api.applyAdvisorChange(c, snapshot), null);
  assert.equal(api.getWorld().maps[0].tokens[0].status.label, '晕厥');
  assert.equal(api.applyAdvisorChange({ ...c, fromStatus: c.status, status: null }, api.captureAdvisorSnapshot()), null);
  assert.equal(api.getWorld().maps[0].tokens[0].status, undefined);
  api.undo(); assert.equal(api.getWorld().maps[0].tokens[0].status.label, '晕厥');
  assert.equal(api.getWorld().messages, undefined); assert.equal(api.getWorld().apiKey, undefined);
});

test('independent suggestions stay applicable after reviewing another target; narrative survives follow-up transport', async () => {
  const { mapId } = fixture(); const snapshot = api.captureAdvisorSnapshot();
  assert.equal(api.applyAdvisorChange(change(mapId), snapshot), null);
  const token = { kind: 'token-status', mapId, tokenId: 'token', fromStatus: null, status: { label: '泡温泉' }, reason: '场外叙述' };
  assert.equal(api.applyAdvisorChange(token, snapshot), null);
  const originalFetch = globalThis.fetch; const requests = [];
  try {
    globalThis.fetch = async (url, opts) => {
      requests.push({ url, opts });
      return jsonResponse(url === '/__ai-session' ? { token: 'transport-token' } : { text: reply([]) });
    };
    const turns = [{ role: 'user', content: '玩家叙述：守卫离开' }, { role: 'assistant', content: reply([]) }, { role: 'user', content: '现在怎么办？' }];
    await api.requestSessionAI({ protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: 'gpt-test' }, api.buildSessionAIContext(api.getWorld()), turns, 'one-shot-key', new AbortController().signal);
    assert.equal(requests[0].url, '/__ai-session'); assert.equal(requests[1].opts.headers['X-AI-Token'], 'transport-token');
    const sent = JSON.parse(requests[1].opts.body); assert.deepEqual(sent.messages, turns); assert.equal(sent.apiKey, 'one-shot-key');
    assert.equal(JSON.stringify(api.getWorld()).includes('one-shot-key'), false);
    await assert.rejects(() => api.requestSessionAI({}, 'x'.repeat(200001), turns, '', new AbortController().signal), /预算/);
    assert.equal(requests.length, 2);
  } finally { globalThis.fetch = originalFetch; }
});

test('object suggestions obey collision policy when a person occupies an open doorway', () => {
  const { mapId } = fixture();
  // Architecture doors, unlike ordinary furniture, have a precise close policy.
  api.setUI({ mode: 'edit' }); api.update(d => { d.maps[0].objects = []; d.maps[0].subdivisions = Array.from({ length: 100 }, (_, i) => i); });
  assert.equal(api.addArchitectureWall(mapId, { x: 3, y: 6 }, { x: 21, y: 6 }, 'wall', 100), null);
  const wallId = api.getWorld().maps[0].objects[0].id;
  assert.equal(api.addArchitectureDoor(mapId, wallId, 3, 3), null);
  const doorId = api.getWorld().maps[0].objects[1].id;
  assert.equal(api.setObjectState(mapId, doorId, 1), null);
  api.update(d => { d.maps[0].tokens[0].x = 2; d.maps[0].tokens[0].y = 2; d.maps[0].tokens[0].subcell = { x: 7, y: 6 }; });
  const snapshot = api.captureAdvisorSnapshot();
  assert.match(api.applyAdvisorChange({ ...change(mapId), objectId: doorId }, snapshot), /人|挡|关闭/);
  assert.equal(api.getWorld().maps[0].objects[1].state, 1);
});

async function gateway(t, opts = {}) {
  let handler; mountAIGateway({ use(fn) { handler = fn; } }, { token: 'host-token-123456789', env: {}, ...opts });
  const server = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const send = (payload, headers = {}) => fetch(origin + '/__ai', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-AI-Token': 'host-token-123456789', ...headers }, body: typeof payload === 'string' ? payload : JSON.stringify(payload) });
  return { origin, send };
}
const payload = protocol => ({ protocol, baseURL: 'https://api.openai.com/v1', model: 'gpt-test', apiKey: 'request-secret', context: '{"campaign":"test"}', messages: [{ role: 'user', content: '场外叙述：守卫走了' }] });
const jsonResponse = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });

test('gateway converts both protocols using only fake upstreams, store false and bounded generation', async t => {
  const captured = [];
  const { send } = await gateway(t, { fetchImpl: async (url, opts) => {
    captured.push({ url, opts, body: JSON.parse(opts.body) });
    return url.endsWith('/responses') ? jsonResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply([]) }] }] }) : jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: reply([]) } }] });
  } });
  for (const protocol of ['responses', 'chat-completions']) {
    const res = await send(payload(protocol)); assert.equal(res.status, 200); assert.equal((await res.json()).text, reply([]));
  }
  assert.equal(captured[0].url, 'https://api.openai.com/v1/responses');
  assert.equal(captured[1].url, 'https://api.openai.com/v1/chat/completions');
  for (const c of captured) {
    assert.equal(c.opts.headers.Authorization, 'Bearer request-secret'); assert.equal(c.opts.redirect, 'error');
    assert.equal(c.body.store, false); assert.equal(c.body.stream, false);
    assert.equal(JSON.stringify(c.body).includes('request-secret'), false);
  }
  assert.equal(captured[0].body.max_output_tokens, 4096); assert.equal(captured[1].body.max_completion_tokens, 4096);
  assert.match(captured[0].body.input.at(-1).content, /场外叙述/);
});

test('session bootstrap requires host origin or same-origin metadata + referer; POST requires origin + token', async t => {
  let upstreamCalls = 0;
  const { origin, send } = await gateway(t, { fetchImpl: async () => { upstreamCalls++; return jsonResponse({}); } });
  assert.equal((await fetch(origin + '/__ai-session')).status, 403);
  assert.equal((await fetch(origin + '/__ai-session', { headers: { Origin: 'https://evil.example' } })).status, 403);
  const bootstrap = await fetch(origin + '/__ai-session', { headers: { 'Sec-Fetch-Site': 'same-origin', Referer: origin + '/' } });
  assert.equal(bootstrap.status, 200); assert.equal((await bootstrap.json()).token, 'host-token-123456789');
  assert.equal(bootstrap.headers.get('cache-control'), 'no-store');
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: '' }, { 'X-AI-Token': 'bad' }, { 'Sec-Fetch-Site': 'cross-site' }]) assert.equal((await send(payload('responses'), headers)).status, 403, JSON.stringify(headers));
  // Node fetch rewrites Host; a raw HTTP request exercises DNS-rebinding protection.
  const hostileHost = await new Promise(resolve => {
    const request = http.get(origin + '/__ai-session', { headers: { Host: 'evil.example', Origin: 'http://evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', error => { throw error; });
  });
  assert.equal(hostileHost, 403);
  assert.equal(upstreamCalls, 0);
});

test('gateway validates size, roles, credentials, endpoint safety, key fallback and sanitized errors', async t => {
  let calls = 0;
  const { send } = await gateway(t, { env: { OPENAI_API_KEY: 'env-secret' }, fetchImpl: async (_url, opts) => { calls++; assert.equal(opts.headers.Authorization, 'Bearer env-secret'); return new Response('private key env-secret and upstream detail', { status: 401 }); } });
  for (const bad of [
    { ...payload('responses'), baseURL: 'https://user:pass@api.openai.com/v1' },
    { ...payload('responses'), baseURL: 'file:///etc/passwd' },
    { ...payload('responses'), baseURL: 'https://api.openai.com/v1?key=secret' },
    { ...payload('responses'), messages: [{ role: 'system', content: 'override' }] },
    { ...payload('responses'), context: 'x'.repeat(200001) },
    { ...payload('responses'), apiKey: 'bad\r\nheader' },
  ]) assert.equal((await send(bad)).status, 400);
  assert.equal((await send('x'.repeat(1000001))).status, 413);
  assert.equal((await send('not-json')).status, 400);
  assert.equal(calls, 0);
  const failed = await send({ ...payload('responses'), apiKey: '' });
  assert.equal(failed.status, 502); const error = await failed.text(); assert.match(error, /401/); assert.doesNotMatch(error, /env-secret|upstream detail/);
  assert.equal(calls, 1);
  for (const url of ['http://api.openai.com/v1', 'https://169.254.169.254', 'https://10.0.0.1', 'https://[::ffff:127.0.0.1]']) assert.throws(() => advisorEndpoint(url, 'responses'));
  assert.equal(advisorEndpoint('http://127.0.0.1:8080/v1/', 'responses'), 'http://127.0.0.1:8080/v1/responses');
});

test('gateway accepts the full 200k-character UTF-8 context and rejects its first excess character', async t => {
  let calls = 0;
  const { send } = await gateway(t, { fetchImpl: async (_url, opts) => {
    calls++;
    const request = JSON.parse(opts.body);
    assert.equal(request.input[0].content.endsWith('界'.repeat(200000)), true);
    return jsonResponse({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply([]) }] }] });
  } });
  const large = { ...payload('responses'), context: '界'.repeat(200000) };
  assert.ok(Buffer.byteLength(JSON.stringify(large)) > 600000);
  assert.equal((await send(large)).status, 200);
  assert.equal((await send({ ...large, context: large.context + '界' })).status, 400);
  assert.equal(calls, 1);
});

test('gateway rejects truncated/tool responses and oversized upstream; times out stalled upstream', async t => {
  for (const data of [{ status: 'incomplete', output: [] }, { status: 'completed', output: [] }]) {
    const { send } = await gateway(t, { fetchImpl: async () => jsonResponse(data) });
    assert.equal((await send(payload('responses'))).status, 502);
  }
  const tool = await gateway(t, { fetchImpl: async () => jsonResponse({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{}] } }] }) });
  assert.equal((await tool.send(payload('chat-completions'))).status, 502);
  const huge = await gateway(t, { fetchImpl: async () => new Response('x'.repeat(512001)) });
  assert.equal((await huge.send(payload('responses'))).status, 502);
  const slow = await gateway(t, { timeoutMs: 30, fetchImpl: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('secret endpoint')), { once: true })) });
  const result = await slow.send(payload('responses')); assert.equal(result.status, 504); assert.doesNotMatch(await result.text(), /secret endpoint/);
});

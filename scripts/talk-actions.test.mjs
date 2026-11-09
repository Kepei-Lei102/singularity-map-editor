import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const temp = await mkdtemp(join(tmpdir(), 'ts-talk-'));
const bundle = join(temp, 'editor.cjs');
await build({
  stdin: { contents: `export * from './src/rules/talkActions';`, resolveDir: root },
  outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
});
const api = createRequire(import.meta.url)(bundle);
const { after } = await import('node:test');
after(() => rm(temp, { recursive: true, force: true }));

test('白卡的交流动作一共 10 个', () => {
  assert.equal(api.TALK_ACTIONS.length, 10);
  const names = api.TALK_ACTIONS.map((a) => a.name);
  assert.deepEqual(names, ['【攀谈】', '【私聊】', '【喊话】', '【示意】', '【倾听】', '【对线】', '【求助】', '【微笑】', '【拥抱】', '【亲吻】']);
});

test('交流动作都不掷骰、都不改世界状态', () => {
  for (const a of api.TALK_ACTIONS) {
    assert.equal(a.dice, false, `${a.name} 不该掷骰：对话的效果按内容判`);
    assert.equal(a.changesWorld, false, `${a.name} 是心理层的，不该改世界状态`);
  }
});

test('原话里带字眼时能猜出一个候选', () => {
  assert.equal(api.guessTalkAction('我要去跟那傻子评评理')?.name, '【对线】');
  assert.equal(api.guessTalkAction('小声跟你说件事')?.name, '【私聊】');
  assert.equal(api.guessTalkAction('冲楼上大喊一声')?.name, '【喊话】');
  assert.equal(api.guessTalkAction('拜托帮帮我')?.name, '【求助】');
  assert.equal(api.guessTalkAction('我凑过去听听')?.name, '【倾听】');
  assert.equal(api.guessTalkAction('冲他笑了笑')?.name, '【微笑】');
  assert.equal(api.guessTalkAction('给他一个拥抱')?.name, '【拥抱】');
});

test('猜不出来就不猜，让人自己挑', () => {
  assert.equal(api.guessTalkAction('我走到窗边'), undefined);
  assert.equal(api.guessTalkAction('把钥匙放进兜里'), undefined);
});

test('按名字能查回来', () => {
  assert.equal(api.talkActionByName('【对线】')?.what.includes('不产生实质后果'), true);
  assert.equal(api.talkActionByName('【不存在的】'), undefined);
});

test('描述里带上它是什么', () => {
  const u = { id: 'x', pcId: 'a', pcName: '甲', text: '吵一架', mapId: 'm', at: 0, session: 1, resolution: { label: '【对线】', by: 'witness', at: 0 } };
  assert.match(api.describeTalk(u), /【对线】/);
  assert.match(api.describeTalk(u), /口头交锋/);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = JSON.parse(readFileSync(new URL('../src/rules/actions.json', import.meta.url), 'utf8'));

test('公开动作数据字段齐全、编号唯一', () => {
  assert.deepEqual(Object.keys(pub).sort(), ['actions', 'categories', 'defaults', 'source', 'version']);
  const ids = new Set();
  for (const a of pub.actions) {
    assert.ok(a.id && a.name && a.category);
    assert.ok(Array.isArray(a.attrs));
    assert.ok(a.check && typeof a.check.mode === 'string');
    assert.ok(!ids.has(a.id), `编号重复：${a.id}`);
    ids.add(a.id);
  }
  assert.equal(pub.actions.length, 186);
  assert.equal(pub.defaults.length, 36);
  assert.ok(!pub.categories.some((c) => c.name === '合计'));
});

test('公开动作数据不带解锁来源字段或线索', () => {
  const raw = readFileSync(new URL('../src/rules/actions.json', import.meta.url), 'utf8');
  for (const banned of ['解锁条目数', '涉及途径数', '首个来源', '全部解锁来源', '技能序号', '来源文件']) {
    assert.ok(!raw.includes(banned), `公开文件不该有：${banned}`);
  }
  for (const a of pub.actions) {
    assert.ok(!/来源[：:]/.test(a.desc), `释义还有来源：${a.name}`);
    assert.ok(!a.desc.includes('序列'), `释义还有序列：${a.name}`);
  }
});

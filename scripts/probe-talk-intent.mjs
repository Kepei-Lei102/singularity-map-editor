// 概念验证：大模型能不能把玩家的原话匹配到白卡的 10 个交流动作。
//
// 这是一个独立脚本，不进前端、不进发布包。它的用途只有一个：
// 拿一批原话去问本地网关，看看模型分得准不准，再决定要不要接进主流程。
//
// 用法：
//   OPENAI_BASE_URL=http://127.0.0.1:3425/v1 \
//   OPENAI_API_KEY=magpie \
//   AI_MODEL=private-deepseek/deepseek-v4.1-flash-1017 \
//   node scripts/probe-talk-intent.mjs
//
// 只跑规则（不联网）：node scripts/probe-talk-intent.mjs --offline

import { TALK_ACTIONS, guessTalkAction } from '../src/rules/talkActions.ts';

const BASE = (process.env.OPENAI_BASE_URL ?? 'http://127.0.0.1:3425/v1').replace(/\/+$/, '');
const KEY = process.env.OPENAI_API_KEY ?? 'magpie';
const MODEL = process.env.AI_MODEL ?? 'private-deepseek/deepseek-v4.1-flash-1017';
const OFFLINE = process.argv.includes('--offline');

/**
 * 用来考的句子，每条带人写的正确答案。
 * 故意混进一些「正则抓得到」和「正则抓不到」的，好看出模型补了多少。
 */
const CASES = [
  // 正则能抓到的（考验模型会不会比正则更差）
  { text: '我要去跟那傻子评评理', want: '【对线】' },
  { text: '小声跟你说件事', want: '【私聊】' },
  { text: '冲楼上大喊一声', want: '【喊话】' },
  { text: '拜托帮帮我', want: '【求助】' },
  { text: '我凑过去听听', want: '【倾听】' },
  { text: '给他一个拥抱', want: '【拥抱】' },
  { text: '凑过去亲他一下', want: '【亲吻】' },
  // 正则抓不到的（这些才是模型该补的地方）
  { text: '我冲他笑了笑', want: '【微笑】' },
  { text: '冲他扬了扬下巴', want: '【示意】' },
  { text: '朝他挑了挑眉', want: '【示意】' },
  { text: '我跟他点点头', want: '【示意】' },
  { text: '用胳膊肘捅了他一下', want: '【示意】' },
  { text: '把他拉到一边说话', want: '【私聊】' },
  { text: '拍着他肩膀说没事的', want: '【拥抱】' },
  { text: '跟他扯了两句闲篇', want: '【攀谈】' },
  { text: '问他最近在忙什么', want: '【攀谈】' },
  { text: '扯着嗓子喊他过来', want: '【喊话】' },
  { text: '我朝他眨了眨眼', want: '【示意】' },
  // 边界模糊的（看模型会不会乱猜——猜错了其实也不算错，只是要多点一下）
  { text: '我抬手跟他打个招呼', want: '【示意】' },
  { text: '跟他就这事抬了几句杠', want: '【对线】' },
  // 压根不该匹配到这 10 个的（考验模型会不会硬凑）
  { text: '我到窗边看看外面', want: null },
  { text: '把钥匙放进兜里', want: null },
  { text: '推开门走出去', want: null },
  // ===== 第二批：模拟真实带团时玩家会说的话，更口语、更含糊 =====
  // 对线
  { text: '你他妈再说一遍试试', want: '【对线】' },
  { text: '行啊，那咱就掰扯掰扯', want: '【对线】' },
  { text: '别装了，你心里清楚得很', want: '【对线】' },
  { text: '我倒要听听你怎么解释', want: '【对线】' },
  // 私聊
  { text: '借一步说话', want: '【私聊】' },
  { text: '（给他递个眼色，等人散开）', want: '【私聊】' },
  { text: '等他们走了咱俩聊聊', want: '【私聊】' },
  { text: '我压低声音问他昨晚去哪了', want: '【私聊】' },
  // 喊话
  { text: '老张！你那边情况怎么样', want: '【喊话】' },
  { text: '隔着走廊冲他叫', want: '【喊话】' },
  { text: '扯开嗓子提醒他们快跑', want: '【喊话】' },
  // 求助
  { text: '谁能借我把刀', want: '【求助】' },
  { text: '拉他一把，我腿软了', want: '【求助】' },
  { text: '有没有人帮我按着这个', want: '【求助】' },
  { text: '我这局能不能先撤', want: '【求助】' },
  // 倾听
  { text: '我把耳朵贴在门上', want: '【倾听】' },
  { text: '安静一下，听听外面动静', want: '【倾听】' },
  { text: '竖起耳朵听隔壁', want: '【倾听】' },
  // 示意
  { text: '朝他摆摆手让他别出声', want: '【示意】' },
  { text: '指了指门后的角落', want: '【示意】' },
  { text: '对他比了个三', want: '【示意】' },
  { text: '冲他使了个眼色', want: '【示意】' },
  { text: '我摇摇头', want: '【示意】' },
  // 微笑
  { text: '冲他挤出一个笑', want: '【微笑】' },
  { text: '乐了一下', want: '【微笑】' },
  { text: '对着镜头笑得很甜', want: '【微笑】' },
  // 拥抱
  { text: '一把把他搂过来', want: '【拥抱】' },
  { text: '抱住他让他别抖了', want: '【拥抱】' },
  { text: '拍拍他后背', want: '【拥抱】' },
  // 亲吻
  { text: '低头吻了他', want: '【亲吻】' },
  { text: '在他脸上亲了一口', want: '【亲吻】' },
  // 攀谈
  { text: '跟他唠两句', want: '【攀谈】' },
  { text: '我过去跟他搭话', want: '【攀谈】' },
  { text: '问问他这地方怎么回事', want: '【攀谈】' },
  { text: '跟他聊聊家常', want: '【攀谈】' },
  { text: '随口问他几点了', want: '【攀谈】' },
  // 非交流（考验会不会硬凑）
  { text: '我把桌子推到门后堵住', want: null },
  { text: '蹲下来系鞋带', want: null },
  { text: '掏出打火机点烟', want: null },
  { text: '爬上那个梯子', want: null },
  { text: '我把耳朵塞上', want: null },
  { text: '翻开那本书看看', want: null },
  { text: '把门锁上', want: null },
  { text: '背包里翻出绳子', want: null },
  { text: '我躺下休息', want: null },
  { text: '在纸上画个地图', want: null },
];

const SYSTEM = `你是一个跑团主持人的助手。玩家说了一句话，你要判断它属于下面哪一个交流动作。
只从这 10 个里选，或者回答 null（说明它不属于交流动作）。

${TALK_ACTIONS.map((a) => `${a.name}：${a.what}`).join('\n')}

规则：
- 语气词、动作描写也可能是在交流，要读懂意图，不要只看字面。
- 如果这句话其实不是交流（比如只是移动、拿东西），回答 null。
- 只能返回 JSON：{"action":"【名字】"} 或 {"action":null}
- 不要解释，不要 Markdown，不要加别的字段。`;

/** 问一次网关。失败就返回错误信息，不抛。 */
async function ask(text) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: text },
      ],
      max_completion_tokens: 100,
      temperature: 0,
      stream: false,
    }),
  });
  if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = await res.json();
  const raw = json.choices?.[0]?.message?.content ?? '';
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return { error: `没解析出 JSON: ${raw.slice(0, 120)}` };
  try {
    const v = JSON.parse(m[0]);
    const action = v.action === null ? null : String(v.action);
    return { action };
  } catch {
    return { error: `JSON 不合法: ${m[0].slice(0, 120)}` };
  }
}

async function main() {
  console.log(`模型：${MODEL}`);
  console.log(`网关：${BASE}`);
  console.log(`样本：${CASES.length} 条${OFFLINE ? '（只跑规则，不联网）' : ''}\n`);

  const rows = [];
  for (const c of CASES) {
    const rule = guessTalkAction(c.text)?.name ?? null;
    const ruleOK = rule === c.want;
    let model = null, modelOK = null, err = null;
    if (!OFFLINE) {
      const r = await ask(c.text);
      if (r.error) err = r.error;
      else { model = r.action; modelOK = model === c.want; }
    }
    rows.push({ ...c, rule, ruleOK, model, modelOK, err });
  }

  const pad = (s, n) => String(s ?? '—').padEnd(n);
  const mark = (v) => v === null ? ' ' : v ? '✓' : '✗';
  console.log(`${pad('原话', 22)}${pad('应选', 10)}${pad('规则', 10)}${pad('模型', 10)}规则 模型`);
  console.log('─'.repeat(70));
  for (const r of rows) {
    console.log(`${pad(r.text, 22)}${pad(r.want ?? '(非交流)', 10)}${pad(r.rule ?? '(空)', 10)}${pad(r.err ? '出错' : r.model ?? '(空)', 10)} ${mark(r.ruleOK)}    ${mark(r.modelOK)}`);
    if (r.err) console.log(`    错误：${r.err}`);
  }

  const total = rows.length;
  const ruleHit = rows.filter((r) => r.ruleOK).length;
  console.log('─'.repeat(70));
  console.log(`规则命中 ${ruleHit}/${total}`);
  if (!OFFLINE) {
    const usable = rows.filter((r) => !r.err);
    const modelHit = usable.filter((r) => r.modelOK).length;
    console.log(`模型命中 ${modelHit}/${usable.length}${usable.length < total ? `（${total - usable.length} 条出错未计）` : ''}`);
    const both = rows.filter((r) => r.ruleOK || r.modelOK).length;
    console.log(`两者合一（任一命中就算）${both}/${total}`);
    const bad = rows.filter((r) => !r.ruleOK && !r.modelOK);
    if (bad.length) {
      console.log('\n两边都没命中的：');
      for (const r of bad) console.log(`  「${r.text}」应选 ${r.want ?? '(非交流)'}，规则给 ${r.rule ?? '(空)'}，模型给 ${r.model ?? '(空)'}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

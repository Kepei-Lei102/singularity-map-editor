#!/usr/bin/env node
// 公开仓库闸门：这个仓库是公开的，不许出现真实模组痕迹。
//   node scripts/扫涉密.mjs
// 只扫 git 跟踪的文件（构建产物不入库，扫了没意义）。命中就退出码 1。
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BAD = [
  { re: /爱丽丝模组/, why: '真实模组名' },
  { re: /牛津四角楼/, why: '真实地图名' },
  { re: /送花NPC\.json/, why: '真实关卡文件名' },
  { re: /人物卡[\/\\]工具[\/\\]密档\.mjs/, why: '私有工具路径' },
  { re: /\b0\d\d-\d-\d{3}\b/, why: '技能序号' },
  // 职业名本身是游戏公开资料，只用作输入提示（src/defaults.ts 的 PATHWAY_SUGGESTIONS）；
  // 别的地方出现也是符号，允许。真正要拦的是「序列号」和「技能序号」。
  { re: /盲点发现师|围棋大师|学习家|运动营养师|生活家|社交家/, why: '序列名', allow: /^src\/defaults\.ts$/ },
  { re: /序列\s*[1-9]|序列[一二三四五六七八九]/, why: '序列号' },
  { re: /伊恩|埃莉诺|Elinor|Ward/, why: '真实 NPC 名' },
  { re: /待拍板/, why: '内部流程文件' },
];

const SELF = 'scripts/扫涉密.mjs';
const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).split('\n').filter(Boolean)
  .filter((f) => f !== SELF);

const hits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }   // 二进制跳过
  if (/[\u0000-\u0008]/.test(text.slice(0, 4000))) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const b of BAD) {
      if (b.allow && b.allow.test(f)) continue;
      if (b.re.test(line)) hits.push(`${f}:${i + 1} ${b.why} → ${line.trim().slice(0, 80)}`);
    }
  });
}

if (!hits.length) {
  console.log(`公开仓库闸门：扫了 ${files.length} 个入库文件，没命中。`);
  process.exit(0);
}
console.error(`公开仓库闸门：命中 ${hits.length} 处，这个仓库是公开的，先清掉再提交。`);
for (const h of hits) console.error('  ' + h);
process.exit(1);

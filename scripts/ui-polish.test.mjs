// 试玩占位标签、媒体缩略图的接线。只锁结构：真正的视觉和 IndexedDB 行为由浏览器手测覆盖。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

test('试玩白板占位和媒体缩略图的接线', async () => {
  const [trial, player, media, css] = await Promise.all([
    readFile(join(root, 'src/components/TrialHud.tsx'), 'utf8'),
    readFile(join(root, 'src/components/PlayerView.tsx'), 'utf8'),
    readFile(join(root, 'src/components/MediaPanel.tsx'), 'utf8'),
    readFile(join(root, 'src/styles.css'), 'utf8'),
  ]);

  // 试玩条：可见的「白板占位」+ 说清不是队伍角色
  assert.match(trial, /className="trial-demo"/);
  assert.match(trial, /试玩的角色是新建的白板玩家，不是你队伍里的角色/);

  // 玩家端只在试玩载荷里出徽标；正式窗口 trialFlags 为 null
  assert.match(player, /world\?\.trialFlags[\s\S]{0,120}player-trial-badge/);
  assert.match(player, /试玩占位<\/span>/);

  // 图片走缩略图；缺文件/加载/解码失败都有固定尺寸占位，不挤行
  assert.match(media, /function MediaThumb/);
  assert.match(media, /loading="lazy"/);
  assert.match(media, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(media, /title=\{m\.name\}/);
  assert.match(media, /media-meta-text/);
  assert.match(css, /\.media-thumb-empty::before/);
});

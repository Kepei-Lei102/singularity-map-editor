#!/usr/bin/env python3
"""从「车卡序列资料 EA 前台版」生成全部 16 条途径的序列 9 技能。

这份工作簿一张表对应一条途径（1-16 号），表头写着途径名和职业名，
下面按块重复「技能序号 / 技能名 / 扮演向 / …」15 个字段。
id 前缀就是途径编号：001 控场 → 016 连接。

公开部分只写玩家说明书（id/name/pathway/group/sequence/me/desc）；
判定、动作解锁、关键词、效果原文等留在 私档/skills-ea-private.json。

源表更新后重跑：
  python3 scripts/gen-skills-ea.py
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path('/Volumes/No Access/《奇点之后》车卡序列资料EA前台版V1.1.3(1).xlsx')
PUBLIC_OUT = ROOT / 'src/rules/skills-data.ts'
PRIVATE_OUT = ROOT / '私档/skills-ea-private.json'

# 表号 → 途径名 / 职业名。途径名以「公开序列」表为准，这里写死是为了生成时不依赖表头格式。
PATHWAYS = {
    1:  ('控场途径', '游戏鉴赏家'),
    2:  ('传说途径', '琴师'),
    3:  ('未来途径', '工程师'),
    4:  ('神经网络途径', '优秀提问官'),
    5:  ('太阳途径', 'AI心理师'),
    6:  ('赛博朋克途径', '小说家'),
    7:  ('勇士途径', '运动博主'),
    8:  ('玩家途径', '具身游戏大师'),
    9:  ('童话途径', 'TRPG冒险家'),
    10: ('骑士途径', '历史学家'),
    11: ('生命途径', '医生'),
    12: ('学徒途径', '学习家'),
    13: ('疗愈途径', '自由厨师'),
    14: ('想象途径', '动漫鉴赏家'),
    15: ('DIY途径【线下】', '书画家'),
    16: ('连接途径', '猎头'),
}

LABELS = ['技能序号', '技能名', '扮演向', '关键词', '作用', '效果', '动作解锁', '属性增强', '判定',
          'ME消耗', '技能范围', '技能目标', '技能发动延时', '技能持续时间', '设计者启发思路']
PRIVATE_LABELS = ['关键词', '效果', '动作解锁', '属性增强', '判定', '技能范围', '技能目标',
                  '技能发动延时', '技能持续时间', '设计者启发思路']

ID_RE = re.compile(r'^(\d{3})-(\d)-(\d{3})$')


def clean(value):
    if value is None:
        return ''
    # 源表里不少空单元格被 Excel 填成了数字 0，当作空处理
    if isinstance(value, (int, float)) and value == 0:
        return ''
    text = str(value).replace('\r', '\n')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text)
    return text.strip()


def label_of(cell):
    """把「技能序号：」「关键词： 」这类标签规整成 LABELS 里的名字。"""
    if not isinstance(cell, str):
        return None
    key = cell.strip().rstrip('：:').strip()
    return key if key in LABELS else None


def parse_sheet(ws):
    """扫一遍表：从第一个「技能序号：」开始算技能块。

    表头（途径名、近邻关系、正逆位风格…）也用了同样的「标签：值」格式，
    但那里没有「技能序号」，所以在第一个序号之前一律不收。
    """
    skills, cur, started = [], None, False
    for row in ws.iter_rows(values_only=True):
        key = label_of(row[0] if row else None)
        if key is None:
            continue
        value = row[1] if len(row) > 1 else None
        if key == '技能序号':
            started = True
            cur = {k: '' for k in LABELS}
            skills.append(cur)
        if started and cur is not None:
            cur[key] = clean(value)
    return skills


def main():
    wb = openpyxl.load_workbook(SOURCE, read_only=True, data_only=True)
    public, private, seen = [], [], set()
    for sheet_no, (pathway, prof) in PATHWAYS.items():
        ws = wb[str(sheet_no)]
        for s in parse_sheet(ws):
            sid = s['技能序号']
            if not ID_RE.match(sid):
                continue
            if sid in seen:
                continue
            seen.add(sid)
            prefix, seq, num = ID_RE.match(sid).groups()
            if int(prefix) != sheet_no:
                raise SystemExit(f'{prof}: {sid} 的通径前缀 {prefix} 和第 {sheet_no} 张表对不上')
            if int(seq) != 9:
                continue  # 这份工作簿只放序列 9
            name = re.sub(r'^【|】$', '', s['技能名'])
            group = re.sub(r'^【|】$', '', s['扮演向'])
            # 「1/1回合」「1次效果1点ME」「0（但是每日限一）」都要取第一个数，
            # 不能把所有数字串起来（'1/1回合' 会变成 11）。
            m = re.search(r'\d+', s['ME消耗'])
            me = int(m.group()) if m else 0
            # 玩家说明书 = 作用 + 效果。两段都要，只有作用的话很多技能等于没写。
            desc = ' '.join(x for x in (s['作用'], s['效果']) if x).strip()
            public.append({
                'id': sid, 'name': name, 'pathway': pathway, 'group': group,
                'sequence': int(seq), 'me': me, 'desc': desc,
            })
            private.append({
                'id': sid, 'name': name, 'profession': prof, 'pathway': pathway,
                **{k: s[k] for k in PRIVATE_LABELS},
            })

    public.sort(key=lambda x: x['id'])
    private.sort(key=lambda x: x['id'])

    lines = [
        '// 自动生成，不要手改：python3 scripts/gen-skills-ea.py',
        f'// 来源：{SOURCE.name}',
        '// 只放玩家说明书；判定、动作解锁、效果原文在 私档/skills-ea-private.json。',
        "import type { SkillDef } from './skills';",
        '',
        'export const SKILL_DATA: SkillDef[] = [',
    ]
    for s in public:
        lines.append('  ' + json.dumps(s, ensure_ascii=False) + ',')
    lines.append('];')
    lines.append('')
    PUBLIC_OUT.write_text('\n'.join(lines), encoding='utf-8')

    PRIVATE_OUT.parent.mkdir(exist_ok=True)
    PRIVATE_OUT.write_text(json.dumps({
        'generatedAt': datetime.now(timezone.utc).isoformat(),
        'source': str(SOURCE),
        'skills': private,
    }, ensure_ascii=False, indent=2), encoding='utf-8')

    by_pathway = {}
    for s in public:
        by_pathway[s['pathway']] = by_pathway.get(s['pathway'], 0) + 1
    print(f'公开 {len(public)} 条 / 私有 {len(private)} 条，覆盖 {len(by_pathway)} 条途径')
    for p, n in by_pathway.items():
        print(f'  {p}: {n}')


if __name__ == '__main__':
    main()

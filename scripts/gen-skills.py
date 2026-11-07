#!/usr/bin/env python3
"""从职业工作簿的「序列9」列生成公开技能数据 + 私有技能底档。

公开部分只写 id/name/pathway/group/sequence/me/desc（玩家说明书）。
效果原文、判定、动作解锁、关键词等留在 私档/skills-private.json。
源文件在 /Volumes/No Access/，改源表后重跑：
  python3 scripts/gen-skills.py
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path('/Volumes/No Access')
PUBLIC_OUT = ROOT / 'src/rules/skills-data.ts'
PRIVATE_OUT = ROOT / '私档/skills-private.json'

# 顺序就是玩家看到的职业顺序
TARGETS = [
    {'prof': '动漫鉴赏家', 'pathway': '想象途径', 'file': SOURCE / '已完成/14-想象途径（待升级）2026.2.21.xlsx'},
    {'prof': 'TRPG冒险家', 'pathway': '童话途径', 'file': SOURCE / '已完成/9-TRPG冒险家途径 2026.4.3.xlsx'},
    {'prof': '游戏鉴赏家', 'pathway': '控场途径', 'file': SOURCE / '已完成/1-游戏鉴赏家 控场途径 2026.10.10.xlsx'},
    {'prof': 'AI心理师', 'pathway': '太阳途径', 'file': SOURCE / '已完成/5-AI心理师（待升级） 2026.10.8.xlsx'},
    {'prof': '医生', 'pathway': '生命途径', 'file': SOURCE / '已完成/11-医生-生命途径（待升级） 2026.10.9.xlsx'},
]

LABELS = ['技能序号', '技能名', '扮演向', '关键词', '作用', '效果', '动作解锁', '属性增强', '判定',
          'ME消耗', '技能范围', '技能目标', '技能发动延时', '技能持续时间', '设计者启发思路']


def clean(value):
    if value is None:
        return ''
    text = str(value).replace('\r', '\n')
    text = re.sub(r'[ \t]+', ' ', text)
    text = re.sub(r'\n\s*\n+', '\n', text)
    return text.strip()


def strip_leading_tags(text):
    return re.sub(r'^(?:\s*【[^】]+】\s*)+', '', text).strip()


def tags_of(text):
    return re.findall(r'【([^】]+)】', text)


def parse_me(raw):
    raw = clean(raw)
    if not raw or raw in {'无', '无消耗'}:
        return 0, raw
    m = re.search(r'\d+', raw)
    return (int(m.group()) if m else 0), raw


def read_sequence9(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb['Sheet1']
    rows = list(ws.iter_rows(values_only=True))
    header = rows[0]
    col = next(i for i, v in enumerate(header) if str(v).strip() == '9')
    blocks, cur = [], None
    for row in rows:
        label = clean(row[0]).rstrip('：:')
        value = row[col] if col < len(row) else None
        if label == '技能序号':
            if cur:
                blocks.append(cur)
            cur = {'技能序号': clean(value)}
        elif cur is not None and label in LABELS and value is not None and clean(value):
            cur[label] = clean(value)
    if cur:
        blocks.append(cur)
    return blocks


def desc_of(role, effect, me_raw=''):
    role_text = strip_leading_tags(clean(role))
    effect_text = clean(effect)
    effect_text = re.sub(r'\s*\n\s*', '；', effect_text)
    effect_text = re.sub(r'；{2,}', '；', effect_text)
    effect_text = re.sub(r'。；', '。', effect_text).rstrip('；')
    text = f'{role_text} {effect_text}'.strip()
    note = clean(me_raw)
    if note and not re.fullmatch(r'\d+(ME)?', note):
        text = f'{text}（ME消耗：{note}）'
    return text


def main():
    public, private = [], []
    for target in TARGETS:
        blocks = read_sequence9(target['file'])
        skills = [b for b in blocks if re.fullmatch(r'\d{3}-9-\d{3}', b['技能序号'])]
        if not skills:
            raise SystemExit(f"{target['prof']}: 序列9 没读到技能")
        for b in skills:
            sid = b['技能序号']
            name = clean(b.get('技能名')).strip('【】')
            role = clean(b.get('作用'))
            effect = clean(b.get('效果'))
            me, me_raw = parse_me(b.get('ME消耗'))
            group = (tags_of(role) or ['通用'])[0]
            public.append({
                'id': sid, 'name': name, 'pathway': target['pathway'], 'group': group,
                'sequence': 9, 'me': me, 'desc': desc_of(role, effect, me_raw),
            })
            private.append({
                'id': sid, 'name': name, 'prof': target['prof'], 'pathway': target['pathway'],
                'sequence': 9, 'group': group, 'me': me, 'meRaw': me_raw,
                'desc': desc_of(role, effect, me_raw),
                'role': role, 'effect': effect,
                'check': clean(b.get('判定')), 'actionUnlock': clean(b.get('动作解锁')),
                'keywords': clean(b.get('关键词')), 'playStyle': clean(b.get('扮演向')),
                'range': clean(b.get('技能范围')), 'target': clean(b.get('技能目标')),
                'delay': clean(b.get('技能发动延时')), 'duration': clean(b.get('技能持续时间')),
                'designerNote': clean(b.get('设计者启发思路')),
                'source': target['file'].name,
            })

    ids = [s['id'] for s in public]
    if len(set(ids)) != len(ids):
        raise SystemExit('技能 id 有重复')
    for s in public:
        if not s['name'] or not s['desc'] or not s['pathway']:
            raise SystemExit(f"字段为空: {s['id']}")
        if not re.fullmatch(r'\d{3}-9-\d{3}', s['id']):
            raise SystemExit(f"id 不符合序列9格式: {s['id']}")
        if set(s) != {'id', 'name', 'pathway', 'group', 'sequence', 'me', 'desc'}:
            raise SystemExit(f"公开字段不对: {s['id']}")

    lines = [
        '// 自动生成，不要手改：python3 scripts/gen-skills.py',
        '// 只放玩家说明书；判定、动作解锁、效果原文在 私档/skills-private.json。',
        "import type { SkillDef } from './skills';",
        '',
        'export const SKILL_DATA: SkillDef[] = [',
    ]
    for s in public:
        lines.append(
            '  { id: %s, name: %s, pathway: %s, group: %s, sequence: 9, me: %d, desc: %s },'
            % (json.dumps(s['id'], ensure_ascii=False), json.dumps(s['name'], ensure_ascii=False),
               json.dumps(s['pathway'], ensure_ascii=False), json.dumps(s['group'], ensure_ascii=False),
               s['me'], json.dumps(s['desc'], ensure_ascii=False)))
    lines.append('];')
    PUBLIC_OUT.write_text('\n'.join(lines) + '\n', encoding='utf-8')

    payload = {
        'version': 'v0.1',
        'generatedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
        'scope': '动漫鉴赏家 / TRPG冒险家 / 游戏鉴赏家 / AI心理师 —— 序列9',
        'count': len(private),
        'skills': private,
    }
    PRIVATE_OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(f'公开 {len(public)} 条 -> {PUBLIC_OUT.relative_to(ROOT)}')
    print(f'私有 {len(private)} 条 -> {PRIVATE_OUT.relative_to(ROOT)}')
    for target in TARGETS:
        n = sum(1 for s in public if s['pathway'] == target['pathway'])
        print(f"  {target['prof']}: {n}")


if __name__ == '__main__':
    main()

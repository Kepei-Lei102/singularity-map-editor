#!/usr/bin/env python3
"""从动作库工作簿生成两份数据：

- 公开：src/rules/actions.json（动作卡、分类说明、白卡默认动作；不含任何解锁来源）
- 私有：私档/actions-unlock.json（解锁明细原样 + 按技能/动作聚合）

用法：
    python3 scripts/gen-actions.py [动作库.xlsx] [私有输出路径]

默认读取：
    /Volumes/No Access/《奇点之后》动作库 V2.1.1(2).xlsx
私有输出默认：
    私档/actions-unlock.json（已被 .gitignore 挡住，不进公开仓库）
"""
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import openpyxl
except ImportError:
    sys.exit('需要 openpyxl：pip3 install openpyxl')

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(
    '/Volumes/No Access/《奇点之后》动作库 V2.1.1(2).xlsx')
OUT_PUBLIC = ROOT / 'src/rules/actions.json'
OUT_PRIVATE = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / '私档/actions-unlock.json'

ATTRS = ['力量', '敏捷', '意志', '观察', '智慧', '魅力']


def text(v):
    return '' if v is None else str(v).strip()


def attrs_of(raw):
    found = []
    for name in re.findall(r'【([^】]+)】', raw):
        if name in ATTRS and name not in found:
            found.append(name)
    return found


def main():
    wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)
    version = text(wb['使用说明'].cell(row=1, column=1).value)  # 仅作标题，不解析

    categories = []
    for row in wb['分类说明'].iter_rows(min_row=2, values_only=True):
        if row and text(row[0]) and text(row[0]) != '合计':
            categories.append({'name': text(row[0]), 'definition': text(row[1])})

    desc = {}
    for row in wb['动作释义'].iter_rows(min_row=2, values_only=True):
        if row and text(row[0]) and text(row[2]):
            desc[text(row[0])] = text(row[2])

    actions = []
    for row in wb['动作库'].iter_rows(min_row=2, values_only=True):
        if not row or row[0] in (None, ''):
            continue
        aid, name, category, _chars, attr_raw, mode, basis = row[:7]
        name = text(name)
        actions.append({
            'id': str(aid).strip(),
            'name': name,
            'category': text(category),
            'attrs': attrs_of(text(attr_raw)),
            'check': {'mode': text(mode), 'basis': text(basis)},
            'desc': desc.get(name, ''),
        })
    actions.sort(key=lambda a: int(a['id']) if a['id'].isdigit() else a['id'])

    defaults = []
    for row in wb['原始动作（白卡默认）'].iter_rows(min_row=2, values_only=True):
        # 表尾有「规则」备注行和空行，不是动作
        if not row or not text(row[0]).isdigit() or not text(row[1]).startswith('【'):
            continue
        seq, name, category, meaning, me = row[:5]
        defaults.append({'id': str(seq).strip(), 'name': text(name), 'category': text(category),
                         'meaning': text(meaning), 'me': int(me) if text(me).isdigit() else 0})

    unlock = []
    for row in wb['解锁明细'].iter_rows(min_row=2, values_only=True):
        if not row or not text(row[0]):
            continue
        action, category, pathway, seq, skill_id, skill_name, source = [text(x) for x in row[:7]]
        unlock.append({
            'action': action, 'category': category, 'pathway': pathway, 'sequence': seq,
            'skillId': skill_id, 'skillName': skill_name, 'source': source,
        })

    # 释义里可能带"来源：某途径某序列某技能"这类解锁线索，公开版把这类分句删掉
    skill_names = {r['skillName'] for r in unlock if r['skillName']}
    pathways = {r['pathway'] for r in unlock if r['pathway'] and r['pathway'] != '—'}

    def clean_desc(text):
        if not text:
            return text
        kept = []
        for part in re.split(r'(?<=[。；])', text):
            if any(n in part for n in skill_names):
                continue
            if any(p in part for p in pathways):
                continue
            if '序列' in part or re.search(r'来源[：:]|来源技能|来源文件', part):
                continue
            kept.append(part)
        return ''.join(kept).strip()

    for a in actions:
        a['desc'] = clean_desc(a['desc'])

    by_skill = {}
    by_action = {}
    for r in unlock:
        s = by_skill.setdefault(r['skillId'], {'skillName': r['skillName'], 'pathway': r['pathway'],
                                              'sequence': r['sequence'], 'actions': []})
        if r['action'] not in s['actions']:
            s['actions'].append(r['action'])
        a = by_action.setdefault(r['action'], [])
        if r['skillId'] not in a:
            a.append(r['skillId'])

    public = {
        'version': 'V2.1.1',
        'source': SRC.name,
        'categories': categories,
        'actions': actions,
        'defaults': defaults,
    }
    OUT_PUBLIC.parent.mkdir(parents=True, exist_ok=True)
    OUT_PUBLIC.write_text(json.dumps(public, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    private = {
        'version': 'V2.1.1',
        'source': SRC.name,
        'generatedAt': datetime.now(timezone.utc).astimezone().isoformat(timespec='seconds'),
        'unlock': unlock,
        'bySkill': by_skill,
        'byAction': by_action,
    }
    OUT_PRIVATE.parent.mkdir(parents=True, exist_ok=True)
    OUT_PRIVATE.write_text(json.dumps(private, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    # 公开文件自检：这些词只应出现在私有文件里
    raw = OUT_PUBLIC.read_text(encoding='utf-8')
    # 公开文件自检：不能出现解锁来源线索
    pub_obj = json.loads(raw)
    skill_names = {r['skillName'] for r in unlock if r['skillName']}
    pathways = {r['pathway'] for r in unlock if r['pathway'] and r['pathway'] != '—'}
    for a in pub_obj['actions']:
        for n in skill_names:
            if n in a['desc']:
                raise SystemExit(f'公开释义里还有技能名：{a["name"]} ← {n}')
        for p in pathways:
            if p in a['desc']:
                raise SystemExit(f'公开释义里还有途径名：{a["name"]} ← {p}')
        if '序列' in a['desc'] or re.search(r'来源[：:]|来源技能|来源文件', a['desc']):
            raise SystemExit(f'公开释义里还有来源线索：{a["name"]}')
    allowed = {'version', 'source', 'categories', 'actions', 'defaults'}
    if set(pub_obj) != allowed:
        raise SystemExit(f'公开文件字段不对：{sorted(pub_obj)}')
    empty = sum(1 for a in actions if not a['desc'])
    print(f'公开 {OUT_PUBLIC.relative_to(ROOT)}：{len(actions)} 个动作、{len(categories)} 个分类、{len(defaults)} 个白卡默认动作；释义清掉来源线索后为空 {empty} 条')
    print(f'私有 {OUT_PRIVATE}：{len(unlock)} 条解锁、{len(by_skill)} 个技能、{len(by_action)} 个动作')


if __name__ == '__main__':
    main()

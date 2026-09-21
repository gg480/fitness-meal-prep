# 动作库采集脚本：按关键词从 ExerciseDB 精准查询 19 个动作的 GIF + 英文指令
# 用法: python -u scripts/fetch_actions.py
# 产出:
#   frontend/src/assets/actions/<key>.gif     — 动作动图
#   frontend/src/assets/actions/<key>.json    — 命中的英文条目（id/name/instructions 等）
# 不走全量分页（150 页太慢）, 改逐个关键词查询, 响应快且无 429
import json
import time
from pathlib import Path

import requests

PROXIES = {'http': 'http://127.0.0.1:7897', 'https': 'http://127.0.0.1:7897'}
H = {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'}
BASE = 'https://oss.exercisedb.dev/api/v1/exercises'

# key → (中文名, 精确搜索词, 命中选择规则)
# prefer: name 必须包含的词; fallback: 若 prefer 无命中退到该词
ACTIONS = {
    'goblet_squat':          ('高脚杯深蹲', 'goblet'),
    'db_bench':              ('哑铃卧推（凳）', 'dumbbell bench press'),
    'db_row_bench':          ('凳上支撑单臂划船', 'one arm row'),
    'rdl':                   ('罗马尼亚硬拉', 'romanian deadlift'),
    'lateral_raise':         ('侧平举', 'lateral raise'),
    'dead_bug':              ('死虫', 'dead bug'),
    'bulgarian_split_squat': ('保加利亚分腿蹲', 'split squat'),
    'half_kneel_press':      ('半跪哑铃推举', 'single arm shoulder press'),
    'bent_over_row':         ('俯身划船', 'bent over row'),
    'single_leg_rdl':        ('单腿硬拉', 'single leg deadlift'),
    'curl':                  ('哑铃弯举', 'dumbbell curl'),
    'ab_wheel':              ('健腹轮', 'wheel rollerout'),
    'wide_goblet_squat':     ('宽距高脚杯蹲', 'goblet'),
    'sumo_squat':            ('相扑蹲', 'sumo squat'),
    'hip_thrust':            ('臀桥', 'hip thrust'),
    'incline_db_bench':      ('上斜卧推', 'incline bench press'),
    'db_pullover':           ('哑铃上拉', 'dumbbell pullover'),
    'triceps_ext':           ('三头伸展', 'triceps extension'),
    'weighted_plank':        ('负重平板', 'weighted front plank'),
}

OUT = Path(__file__).resolve().parents[1] / 'frontend' / 'src' / 'assets' / 'actions'
OUT.mkdir(parents=True, exist_ok=True)


def query(kw):
    """按关键词查 ExerciseDB, 返回命中条目列表"""
    try:
        r = requests.get(BASE, params={'name': kw}, proxies=PROXIES, timeout=40, headers=H)
        if r.status_code == 429:
            time.sleep(20)
            return query(kw)
        r.raise_for_status()
        return r.json().get('data', [])
    except Exception:
        return []


def rank(hits, kw):
    """在命中里挑最贴近的动作: 词全匹配优先, 器械/动作名越接近越靠前"""
    words = kw.lower().split()
    full = [h for h in hits if all(w in h['name'].lower() for w in words)]
    pool = full or hits
    # 接近排序: 命中词多者靠前
    pool.sort(key=lambda h: -sum(1 for w in words if w in h['name'].lower()))
    return pool[0] if pool else None


def main():
    report = []
    for key, (cn, kw) in ACTIONS.items():
        hits = query(kw)
        r = rank(hits, kw)
        if not r:
            report.append({'key': key, 'cn': cn, 'status': 'MISS'})
            print('  %-24s MISS (kw=%s)' % (key, kw))
            continue
        # 下载 GIF
        gif_path = OUT / (key + '.gif')
        size = -1
        try:
            resp = requests.get(r['gifUrl'], proxies=PROXIES, headers=H, timeout=60)
            if resp.status_code == 200 and resp.headers.get('content-type', '').startswith('image'):
                gif_path.write_bytes(resp.content)
                size = len(resp.content)
        except Exception:
            pass
        meta = {'key': key, 'cn': cn, 'ex_name': r['name'], 'exerciseId': r['exerciseId'],
                'gifUrl': r['gifUrl'], 'instructions': r.get('instructions', [])}
        (OUT / (key + '.json')).write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding='utf-8')
        report.append({'key': key, 'cn': cn, 'status': 'OK' if size > 0 else 'GIF_FAIL',
                       'size': size, 'ex_name': r['name']})
        print('  %-24s OK %-44s %d B' % (key, r['name'], size))
        time.sleep(1)

    ok = sum(1 for x in report if x['status'] == 'OK')
    print('\n落盘 GIF:', ok, '/', len(ACTIONS))
    for x in report:
        if x['status'] != 'OK':
            print('  异常:', x['key'], x.get('status'), x.get('ex_name', ''))
    (Path(__file__).resolve().parents[1] / 'verify' / 'actions_fetch_report.json') \
        .write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print('报告: verify/actions_fetch_report.json')


if __name__ == '__main__':
    main()
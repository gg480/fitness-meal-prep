# -*- coding: utf-8 -*-
"""v3.1 补打卡真机动线验证（本地后端 + 真实开发库 + 新构建产物）
跑法：python verify/backfill_e2e.py；退出码 0 = 全部通过。"""
import datetime
import json
import sys
import urllib.request
from playwright.sync_api import sync_playwright

BASE = 'http://localhost:3000'
TODAY = datetime.date.today()
Y = (TODAY - datetime.timedelta(days=1)).isoformat()   # 昨天（饮食补录）
Y2 = (TODAY - datetime.timedelta(days=2)).isoformat()  # 前天（训练补录）

errors = []
results = []

def api(path):
    with urllib.request.urlopen(BASE + '/api' + path) as r:
        return json.load(r)

def report(name, ok, detail=''):
    results.append((name, ok))
    print(('  PASS  ' if ok else '  FAIL  ') + name + (('  ' + str(detail)) if detail else ''))

def pick_date(page, iso):
    """翻到 iso 所在月并点击该日号"""
    ymd = [int(x) for x in iso.split('-')]
    for _ in range(4):
        title = page.locator('.cal-title').inner_text()
        if title == f'{ymd[0]} 年 {ymd[1]} 月':
            break
        page.click('.cal-nav-btn[aria-label="上个月"]')
    page.locator('.cal-day:not(.off)', has_text=str(ymd[2])).first.click()

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page(viewport={'width': 420, 'height': 920})
    page.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' else None)
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))

    page.goto(BASE, wait_until='networkidle')
    page.wait_for_selector('.sec-head .cal-btn', timeout=15000)
    mounted = page.evaluate("document.querySelector('#app').innerHTML.length")
    report('Vue 已挂载（#app 长度 > 5000）', mounted > 5000, mounted)

    # ========== 1. 今日页饮食补录 ==========
    print('\n[1] 今日页补录（昨天）')
    page.click('.sec-head .cal-btn')
    page.wait_for_selector('.cal-mask .cal-card', timeout=5000)
    report('补录按钮 → 日历弹层', True)
    pick_date(page, Y)
    page.wait_for_selector('text=补录记录', timeout=5000)
    page.wait_for_timeout(300)
    report('选昨天 → 历史视图（标题以「补录 ·」开头）',
           page.locator('.sec-head').inner_text().startswith('补录 ·'),
           page.locator('.sec-head').inner_text())
    page.locator('.card:has-text("补录记录") button[aria-label="增加"]').click()  # 份数 +0.1（MEAL_STEP=0.1，与今日页一致）
    page.locator('label.bf-check input[type=checkbox]').check()
    page.locator('.card:has-text("补录记录") .seg-item', has_text='只做有氧').click()  # 'rest' 档
    page.locator('button:has-text("保存补录")').click()
    page.wait_for_selector('.sec-head:has-text("今日 ·")', timeout=5000)
    report('保存补录 → 自动返回今日视图', True)

    dl = api('/day-logs').get('data', {})
    row = dl.get(Y, {})
    report('API：昨天 meals=0.1（MEAL_STEP 步进一次）', row.get('meals') == 0.1, row.get('meals'))
    report('API：昨天 checkedIn=1', int(row.get('checkedIn') or 0) == 1, row.get('checkedIn'))
    report('API：昨天 dayType=rest（只做有氧档）', row.get('dayType') == 'rest', row.get('dayType'))

    # 二次进入验证锁定
    page.click('.sec-head .cal-btn')
    page.wait_for_selector('.cal-mask', timeout=5000)
    pick_date(page, Y)
    page.wait_for_selector('text=已补录打卡', timeout=5000)
    inc = page.locator('.card:has-text("补录记录") button[aria-label="增加"]')
    report('二次进入：份数步进器锁定（disabled）', inc.is_disabled())
    page.click('.sec-head .cal-btn:has-text("返回今日")')
    page.wait_for_selector('.sec-head:has-text("今日 ·")', timeout=5000)

    # ========== 2. 训练页补录 ==========
    print('\n[2] 训练页补录（前天）')
    page.locator('.tabbar button', has_text='训练').click()
    page.wait_for_selector('.sec-head .cal-btn', timeout=5000)
    page.click('.sec-head .cal-btn')
    page.wait_for_selector('.cal-mask', timeout=5000)
    pick_date(page, Y2)
    page.wait_for_selector('text=补录', timeout=5000)
    page.wait_for_timeout(400)
    report('选前天 → 训练中视图带「补录」标签',
           page.locator('.bf-tag').count() > 0, page.locator('.bf-tag').first.inner_text() if page.locator('.bf-tag').count() else '(无)')
    # 逐组确认直到全部完成
    guard = 0
    while page.locator('button:has-text("✓ 确认")').count() > 0 and guard < 40:
        page.locator('button:has-text("✓ 确认")').first.click()
        page.wait_for_timeout(120)
        guard += 1
    done_btn = page.locator('button:has-text("保存补录")')
    report('全组确认后「保存补录」可用', done_btn.count() > 0 and not done_btn.first.is_disabled())
    done_btn.first.click()
    page.wait_for_selector('.bf-banner', timeout=5000)
    report('持久横幅出现（已补录 X月X日 X练 · 撤销）', True, page.locator('.bf-banner').inner_text())

    tw = api('/training/workouts').get('data', [])
    hit = [w for w in tw if w.get('date') == Y2]
    report('API：前天训练记录落库', len(hit) == 1, str(len(hit)))

    # ========== 3. 记录页徽章 ==========
    print('\n[3] 记录页徽章')
    page.locator('.tabbar button', has_text='记录').click()
    page.wait_for_selector('text=每日饮食回溯', timeout=5000)
    page.wait_for_timeout(400)
    texts = [page.locator('.history-card').nth(i).inner_text() for i in range(page.locator('.history-card').count())]
    bf_card = [t for t in texts if '补录' in t]
    report('训练补录日卡片含虚线「补录」徽章', len(bf_card) >= 1, bf_card[0][:80] if bf_card else '(无)')
    report('训练补录日卡片含「力量 · 课表」标签', len([t for t in texts if '力量 · 课表' in t]) >= 1)

    # ========== 4. 撤销补录 ==========
    print('\n[4] 撤销训练补录')
    page.locator('.tabbar button', has_text='训练').click()
    page.wait_for_timeout(300)
    if page.locator('.bf-banner').count() > 0:
        page.locator('.bf-banner button:has-text("撤销")').click()
        page.wait_for_timeout(500)
        report('点撤销 → 横幅消失', page.locator('.bf-banner').count() == 0)
        tw2 = api('/training/workouts').get('data', [])
        report('API：撤销后训练记录删除', len([w for w in tw2 if w.get('date') == Y2]) == 0)
    else:
        report('点撤销 → 横幅消失', False, '未找到横幅')

    # ========== 5. 收尾 ==========
    print('\n[5] Console 错误检查')
    report('Console / 页面错误数量为 0', len(errors) == 0, '; '.join(errors[:5]))
    browser.close()

print('\n=== 汇总 ===')
fails = [r for r in results if not r[1]]
print(f'通过 {len(results) - len(fails)} / {len(results)}')
if fails:
    print('失败项：' + ', '.join(f[0] for f in fails))
    sys.exit(1)

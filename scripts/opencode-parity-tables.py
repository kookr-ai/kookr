#!/usr/bin/env python3
"""Build the parity comparison tables for docs/reports/opencode-parity.md.

Reads (read-only): bake-off results (opencode arm runs, table.py conventions), Hermes exp dirs, and the
opencode-via-Kookr result dirs written by scripts/opencode-parity.ts. Prints markdown to stdout.
Every cell is tagged by source: K = measured here via Kookr; B = reused bake-off; H = reused Hermes data.
"""
import json, os, re, statistics as st

HS = os.path.expanduser('~/hermes-sandbox/shadow-run/')
BK = HS + 'bakeoff/results/'
EXP = HS + 'exp/'
CASES = ['agent-notebook-90', 'agent-notebook-273', 'agent-notebook-300', 'lucy-3265', 'knowledge-base-mcp-server-1165', 'lucy-3315']


def J(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


def est(t):  # table.py's price model: $0.10/M uncached, $0.01/M cached, $0.20/M out
    return (t['uncached'] * 0.10 + t['cached'] * 0.01 + t['out'] * 0.20) / 1e6


def secs(exit_txt):
    m = re.search(r'secs=(\d+)', exit_txt)
    return int(m.group(1)) if m else None


def mem_peaks(csv):
    try:
        rows = [l.strip().split(',') for l in open(csv).read().strip().split('\n')[1:]]
        return dict(cg=max(float(r[2]) for r in rows), harness=max(float(r[3]) for r in rows), other=max(float(r[4]) for r in rows))
    except Exception:
        return None


def verdict(d):
    try:
        return open(d + '/verdict.txt').read().split(':')[0].strip()
    except Exception:
        return 'ungraded'


def kookr_row(case):
    d = BK + case + '-opencode-kookr'
    r = J(d + '/report.json')
    if not r:
        return None
    m = J(d + '/kookr-metrics.json') or {}
    u = m.get('usage') or {}
    rss = m.get('peak_rss_mb') or {}
    return dict(
        delivered=r['delivered'], committed=r['committed'], gate=m.get('gate_blocks_plugin_debug'), stops=m.get('stop_events'),
        ref=verdict(d), secs=secs(r['exit']), tok_in=u.get('inputTokens'), tok_cache=u.get('cacheReadTokens'), tok_out=u.get('outputTokens'),
        cost=u.get('costUsd'), harness=rss.get('harness_tui'), other=rss.get('other_tool_children'), total=rss.get('total_tree'), pss=rss.get('total_pss'),
        files=r['diff']['files'], done=m.get('done_reason'), task=m.get('task_id'))


def bakeoff_rows(case):
    out = []
    for suf in ['', '-r2', '-r3']:
        d = BK + case + '-opencode' + suf
        r = J(d + '/report.json')
        if not r:
            continue
        t = J(d + '/tokens.json')
        nr = J(d + '/nudge-report.json')
        mp = mem_peaks(d + '/mem.csv')
        out.append(dict(run=suf or 'r1', delivered=r['delivered'], nudges=(nr or {}).get('nudges', 0), ref=verdict(d), secs=secs(r['exit']),
                        cost=est(t) if t else None, tokens=t, mem=mp))
    return out


def hermes(case, suffix):
    d = EXP + f'{case}-{suffix}'
    r = J(d + '/report.json')
    if not r or not os.path.exists(d + '/exit.txt'):
        return None
    va = J(d + '/validate.json')
    ref = 'n/a' if not va else ('PASS' if (va.get('hermes_with_ref_tests') or {}).get('ok') else 'FAIL')
    return dict(raw=r.get('raw_delivered', r.get('delivered')), deliv=r.get('delivered'), nud=r.get('nudges', 0), ref=ref, secs=secs(open(d + '/exit.txt').read()))


def yn(b):
    return 'Y' if b else 'N'


def fm(x, f='{:.0f}'):
    return '–' if x is None else f.format(x)


print('### Table 1 — delivery / verdict / time / cost, per case\n')
print('K = measured now through Kookr (this report); B = reused bake-off opencode runs (docker `opencode run`, no Kookr gate; best = PASS first then fastest, median over secs); H = reused Hermes data (read-only). '
      '"delivered(raw)" = committed + lint-clean PR body at the first stop, before any nudge. For B, "nudges" = post-hoc nudges the bake-off needed; for K, "gate blocks" = Stop-hook blocks by the Kookr deliverable gate (exit 2).\n')
print('| case | K deliv final (first-stop) | K gate blocks | K ref | K secs | K tokens in/cache/out | K cost $ | B n | B deliv(raw) best/med | B ref best | B secs best/med | B est $ med | H raw | H nudged (nudges) | H ref | H secs raw/nudged |')
print('|' + '---|' * 16)
for c in CASES:
    k = kookr_row(c)
    b = bakeoff_rows(c)
    hr, hn = hermes(c, 'off'), hermes(c, 'offnudge')
    if hr and hr.get('nud') is not None and not hn:
        hn = hr
    if k:
        kcols = [f"{yn(k['delivered'])} ({yn(k['delivered'] and not k['gate'])})", fm(k['gate']), k['ref'], fm(k['secs']), f"{fm(k['tok_in'])}/{fm(k['tok_cache'])}/{fm(k['tok_out'])}", fm(k['cost'], '{:.4f}')]
    else:
        kcols = ['–'] * 6
    if b:
        order = sorted(b, key=lambda x: (x['ref'] != 'PASS', not x['delivered'], x['secs'] or 1e9))
        best = order[0]
        secs_l = [x['secs'] for x in b if x['secs'] is not None]
        costs = [x['cost'] for x in b if x['cost'] is not None]
        bcols = [str(len(b)), f"{sum(1 for x in b if x['delivered'])}/{len(b)} raw delivered", best['ref'], f"{best['secs']}/{st.median(secs_l):.0f}", fm(st.median(costs) if costs else None, '{:.3f}')]
        bcols[1] = f"{yn(best['delivered'])} (n_deliv {sum(1 for x in b if x['delivered'])}/{len(b)})"
    else:
        bcols = ['–'] * 5
    hcols = [yn(hr['raw']) if hr else '–', (f"{yn(hn['deliv'])} ({hn['nud']})" if hn else '–'), (hr or hn or {}).get('ref', '–'), (f"{hr['secs'] if hr else '–'}/{hn['secs'] if hn else '–'}")]
    print(f'| {c} | ' + ' | '.join(kcols + bcols + hcols) + ' |')

print('\n### Table 2 — RAM (MB, peak over the run)\n')
print('K: sampled every 2 s from the process tree of the task (cwd inside the clone + descendants): harness = opencode TUI process, other = tool children (node/vitest/npm/git...), total = both plus dtach/wrappers, PSS = proportional set size of the same tree. '
      'B: docker cgroup peak (`cg_peak_mb`, includes page cache of the container) and harness-process RSS peak from mem.csv of the bake-off run with the highest cg peak; Hermes was not memory-sampled.\n')
print('| case | K harness RSS | K tool-children RSS | K tree total RSS | K tree PSS | B cgroup peak (max of runs) | B harness RSS peak | B other RSS peak |')
print('|' + '---|' * 8)
for c in CASES:
    k = kookr_row(c)
    b = [x['mem'] for x in bakeoff_rows(c) if x['mem']]
    bm = max(b, key=lambda m: m['cg']) if b else None
    print(f"| {c} | {fm(k and k['harness'])} | {fm(k and k['other'])} | {fm(k and k['total'])} | {fm(k and k['pss'])} | "
          f"{fm(bm and bm['cg'])} | {fm(bm and max(m['harness'] for m in b))} | {fm(bm and max(m['other'] for m in b))} |")

print('\n### Table 3 — bake-off opencode runs (reused, per run)\n')
print('| case | run | delivered(raw) | nudges needed | ref | secs | est $ | cg peak MB |')
print('|' + '---|' * 8)
for c in CASES:
    for x in bakeoff_rows(c):
        print(f"| {c} | {x['run']} | {yn(x['delivered'])} | {x['nudges']} | {x['ref']} | {fm(x['secs'])} | {fm(x['cost'], '{:.3f}')} | {fm(x['mem'] and x['mem']['cg'])} |")

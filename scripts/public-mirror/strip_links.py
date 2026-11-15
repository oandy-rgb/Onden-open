# Turns markdown links whose target is a file this push REMOVED (docs images, the scan reports) into plain text.
# Only those: a link to something that never existed (an example inside a code span) is left alone, and a label may
# not contain "[" or a line break, so the match cannot run across unrelated text.
import os, re, subprocess
removed = set(subprocess.check_output(['git', 'diff', '--cached', '--name-only', '--diff-filter=D', '-z'], text=True).split('\0'))
files = subprocess.check_output(['git', 'ls-files', '*.md'], text=True).split('\n')
pat = re.compile(r'(!?)\[([^\[\]\n]*)\]\(([^()\s]+)(\s+"[^"\n]*")?\)')
n = 0
for f in files:
    if not f or not os.path.exists(f): continue
    s = open(f, encoding='utf8').read()
    def rep(m):
        global n
        t = m.group(3).split('#')[0]
        if not t or re.match(r'[a-z][a-z0-9+.-]*:', t): return m.group(0)
        p = os.path.normpath(os.path.join(os.path.dirname(f), t))
        if p not in removed: return m.group(0)
        n += 1
        label = m.group(2).strip() or os.path.basename(t)
        img = re.search(r'\.(png|jpe?g|webp|gif)$', t, re.I)
        return f"（截圖未隨公開庫附上：{label}）" if img else f"{label}（未隨公開庫附上）"
    new = pat.sub(rep, s)
    if new != s: open(f, 'w', encoding='utf8').write(new)
print("links rewritten", n)

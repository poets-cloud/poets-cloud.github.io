import json, glob, os
from collections import Counter

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- web poems ---
files = glob.glob(os.path.join(root, 'data', 'web', 'poems', 'chunk-*.json'))
dyn_counter = Counter()
auth_counter = Counter()
cnt = 0
for f in files:
    with open(f, encoding='utf-8') as fp:
        arr = json.load(fp)
    for p in arr:
        dyn_counter[p.get('dynasty', '?')] += 1
        auth_counter[(p.get('dynasty', '?'), p.get('authorName', '?'))] += 1
        cnt += 1

print(f"=== WEB poems: {cnt} total ===")
print("Dynasties:", dict(dyn_counter))
print("Unique (dynasty, author):", len(auth_counter))
for (d, a), n in auth_counter.most_common():
    print(f"  {d} | {a}: {n}")

# --- raw source ---
print()
raw_root = os.path.join(root, 'data', 'raw', 'chinese-poetry')
raw_dirs = []
if os.path.isdir(raw_root):
    for d in os.listdir(raw_root):
        p = os.path.join(raw_root, d)
        if os.path.isdir(p):
            raw_dirs.append(p)
            print(f"Raw dir: {d}")
else:
    print("No raw chinese-poetry dir")

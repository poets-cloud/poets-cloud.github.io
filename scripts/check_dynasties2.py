import json, glob, os, sys
from collections import Counter

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# --- web poems ---
files = sorted(glob.glob(os.path.join(root, 'data', 'web', 'poems', 'chunk-*.json')))
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
if os.path.isdir(raw_root):
    for d in os.listdir(raw_root):
        p = os.path.join(raw_root, d)
        if os.path.isdir(p):
            print(f"Raw dir: {d}")
            # count files
            sub = glob.glob(os.path.join(p, '*.json'))
            print(f"  {len(sub)} json files")

# examine raw file structure
raw_files = glob.glob(os.path.join(raw_root, '**', '*.json'), recursive=True)
if raw_files:
    sample = raw_files[0]
    print(f"\nSample raw file: {os.path.relpath(sample, raw_root)}")
    with open(sample, encoding='utf-8') as fp:
        data = json.load(fp)
    if isinstance(data, list):
        print(f"  Array of {len(data)} items")
        if data:
            print("  Keys:", list(data[0].keys()))
            ex = data[0]
            print(f"  title={ex.get('title')}, author={ex.get('author')}, dynasty={ex.get('dynasty')}")
    elif isinstance(data, dict):
        print("  Dict keys:", list(data.keys()))
        print(f"  dynasty={data.get('dynasty')}")

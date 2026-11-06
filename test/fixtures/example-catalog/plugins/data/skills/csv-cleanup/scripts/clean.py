import csv, sys
rows = list(csv.reader(open(sys.argv[1], newline="", encoding="utf-8-sig")))
header = [h.strip().lower().replace(" ", "_") for h in rows[0]]
seen, out = set(), [header]
for r in rows[1:]:
    t = tuple(c.strip() for c in r)
    if t not in seen:
        seen.add(t); out.append(list(t))
csv.writer(sys.stdout).writerows(out)
print(f"{len(rows) - len(out)} duplicate rows removed", file=sys.stderr)

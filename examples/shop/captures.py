r"""Renders the README demo captures (docs/assets/demo-*.svg) from the real output of demo.sh.

From the repository root, on a fresh demo database so that the audit log holds only the demo's reads:

    docker compose --profile demo down -v && docker compose --profile demo up -d --build --wait
    docker compose --profile demo logs --no-log-prefix seed > /tmp/seed.txt
    examples/shop/demo.sh | sed 's/\x1b\[[0-9;]*m//g' > /tmp/demo.txt
    python3 examples/shop/captures.py /tmp/demo.txt /tmp/seed.txt docs/assets
"""
import re
import sys
from html import escape
from pathlib import Path

demo_path, seed_path, out = sys.argv[1:4]

END = re.compile(r"reachable as|^Pulled as|nodes?, \d+ edges? in |audit entries\.$|: 403 ")
blocks, current = [], []
for line in Path(demo_path).read_text().splitlines():
    if line == "" or line.startswith("   ") or re.match(r"^\d\. ", line) or re.match(r"^\w+ \[[^\]]*\]$", line):
        continue
    current.append(line.replace("/tmp/cache.db", "./cache.db").replace("http://api:8080", "$GWARDEN_API"))
    if END.search(line):
        blocks.append(current)
        current = []
assert len(blocks) == 15, [b[-1] for b in blocks]
(bob1, alice1, carla1, lea1, bob2, lea2, pull, cache, marie, sofia, lea4, yanis, lea5, denied, audit) = blocks
seed = [l for l in Path(seed_path).read_text().splitlines() if l.strip()]

GREEN, CMD, GREY, TEXT, BLUE, RED, NOTE = "#7fd18b", "#e6edf3", "#7d8a96", "#d6dde4", "#6cb6ff", "#ff7b72", "#f0b35b"
NODE = re.compile(r"^(\S+\s+\S+\s+(?:\"[^\"]*\"\s+)?)(\[[^\]]+\])$")


def cmd(text):
    return [(GREEN, "$ ", False), (CMD, text, True)]


def output(lines):
    rows = []
    for line in lines:
        node = NODE.match(line)
        if node:
            rows.append([(TEXT, node.group(1), False), (BLUE, node.group(2), False)])
        elif line.startswith("0 nodes reachable") or ": 403 " in line or line.endswith("DENIED"):
            rows.append([(RED, line, False)])
        elif END.search(line) or line.startswith("Ingested") or line.startswith("Narrowed"):
            rows.append([(GREY, line, False)])
        else:
            rows.append([(TEXT, line, False)])
    return rows


def run(command, lines):
    return [cmd(command), *output(lines)]


BLANK = [[(TEXT, "", False)]]


def svg(name, title, rows):
    width = round(36 + 8.1 * max(sum(len(t) for _, t, _ in row) for row in rows))
    height = 58 + 20 * (len(rows) - 1) + 20
    texts = []
    for i, row in enumerate(rows):
        spans = "".join(
            f'<tspan fill="{fill}"{" font-weight=\"600\"" if bold else ""}>{escape(t, quote=False)}</tspan>' for fill, t, bold in row
        )
        texts.append(f'  <text x="18" y="{58 + 20 * i}">{spans}</text>')
    t = escape(title)
    half = width / 2
    centre = int(half) if half == int(half) else half
    doc = f"""<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{t}">
  <title>{t}</title>
  <rect width="{width}" height="{height}" rx="10" fill="#0f1419"/>
  <path d="M0 10a10 10 0 0 1 10-10h{width - 20}a10 10 0 0 1 10 10v18H0z" fill="#1c232b"/>
  <circle cx="18" cy="14" r="5.5" fill="#ff5f57"/><circle cx="36" cy="14" r="5.5" fill="#febc2e"/><circle cx="54" cy="14" r="5.5" fill="#28c840"/>
  <text x="{centre}" y="18" text-anchor="middle" fill="#7d8a96" font-family="ui-sans-serif,system-ui,sans-serif" font-size="12">{t}</text>
  <g font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13.5" xml:space="preserve" style="white-space:pre">
{chr(10).join(texts)}
  </g>
</svg>
"""
    Path(out, f"{name}.svg").write_text(doc)
    print(name, width, height)


views = "gwarden traverse orders-api --direction both --depth 2"
svg(
    "demo-1-views",
    "One graph, four views of GET /orders",
    [[(NOTE, "# same question, same graph: each person sees only what their groups allow", False)]]
    + run(f"GWARDEN_TOKEN=$BOB {views}", bob1) + BLANK
    + run(f"GWARDEN_TOKEN=$ALICE {views}", alice1) + BLANK
    + run(f"GWARDEN_TOKEN=$CARLA {views}", carla1) + BLANK
    + run(f"GWARDEN_TOKEN=$LEA {views}", lea1),
)
svg(
    "demo-2-derived",
    "A derived summary takes the scope of all its sources",
    run("gwarden ingest examples/shop/docs --source docs:shop --user lea --team ...", seed) + BLANK
    + run("GWARDEN_TOKEN=$BOB gwarden traverse pagination-impact      # bob is only in bff", bob2) + BLANK
    + run("GWARDEN_TOKEN=$LEA gwarden traverse pagination-impact      # lea is in dev-leads", lea2),
)
svg(
    "demo-3-pull",
    "Pull: a local cache with only what you may see",
    run("GWARDEN_TOKEN=$ALICE gwarden pull --cache ./cache.db", pull) + run("gwarden cache --cache ./cache.db", cache),
)
svg(
    "demo-4-contract",
    "One contract, two teams, each sees its side",
    run("GWARDEN_TOKEN=$MARIE gwarden traverse clickstream-events --direction in --depth 2   # shopping-front", marie) + BLANK
    + run("GWARDEN_TOKEN=$SOFIA gwarden traverse incident-208 --direction both --depth 1     # data", sofia) + BLANK
    + run("GWARDEN_TOKEN=$LEA gwarden traverse incident-208 --direction both --depth 1       # every team", lea4),
)
svg(
    "demo-5-profile",
    "A summary derived from three teams",
    run("GWARDEN_TOKEN=$YANIS gwarden traverse profile-v2-impact --depth 1   # yanis is only in user", yanis) + BLANK
    + run("GWARDEN_TOKEN=$LEA gwarden traverse profile-v2-impact --depth 1     # lea is in dev-leads", lea5),
)
svg(
    "demo-6-audit",
    "Every read is audited, and only auditors read the log",
    run("GWARDEN_TOKEN=$BOB gwarden audit", denied) + BLANK + run("GWARDEN_TOKEN=$DPO gwarden audit", audit),
)

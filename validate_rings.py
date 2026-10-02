"""
Check the browser ring physics (docs/rings.js) against rings.py.

Runs the same cases through both, including the J2 node drift computed from
dates on each side, and compares the arcs above the horizon, in sunlight and
visible, and the brightest visible patch. Both sample the ring at the same
points, so they should agree to rounding.

    python3 validate_rings.py        # needs node on the PATH

Exits non-zero on any mismatch.
"""

import json
import os
import subprocess
import sys
import tempfile

import rings as RG
import solar
import twilight as T

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_ARC = 0.01  # degrees of arc
MAX_MAG = 1e-6  # magnitudes
EPOCH = (2026, 3, 20)

R = lambda alt, inc=0.0, raan=0.0, width=100.0, albedo=0.2: dict(
    alt=alt, inc=inc, raan=raan, width=width, albedo=albedo
)

CASES = [
    dict(ring=R(1000), date=(2026, 9, 22), lat=20.0, mins=120),
    dict(ring=R(3000), date=(2026, 9, 22), lat=20.0, mins=120),
    dict(ring=R(3000, width=1), date=(2026, 9, 22), lat=20.0, mins=120),
    dict(ring=R(500), date=(2026, 9, 22), lat=0.0, mins=360),  # midnight, shadowed
    dict(ring=R(2000), date=(2026, 9, 22), lat=45.0, mins=120),  # below the horizon
    dict(ring=R(2000, 45, 0), date=(2026, 9, 22), lat=20.0, mins=120),
    dict(ring=R(2000, 45, 0), date=(2026, 9, 22), lat=20.0, mins=540, prec=True),
    dict(ring=R(2000, 45, 0), date=(2026, 12, 21), lat=37.2, mins=600, prec=True),
    dict(ring=R(3000, 50, 200), date=(2026, 6, 21), lat=55.0, mins=90, prec=True),
    dict(
        ring=R(800, 98.6, 90), date=(2026, 12, 21), lat=60.0, mins=300, prec=True
    ),  # retrograde
    dict(ring=R(2000, 90, 30), date=(2026, 3, 20), lat=70.0, mins=240),
    dict(ring=R(5000, 20, 300), date=(2026, 9, 22), lat=-33.9, mins=100, bortle=5),
    dict(ring=R(20000), date=(2026, 9, 22), lat=-33.9, mins=60, bortle=8),
    dict(ring=R(300, width=50000), date=(2026, 9, 22), lat=5.0, mins=40),  # wide band
    dict(ring=R(10000, 30, 120, albedo=0.05), date=(2027, 1, 15), lat=51.5, mins=30),
]


def python_side():
    out = []
    for c in CASES:
        dec, ra = solar.sun(*c["date"])
        lst = solar.sunset_lst(c["lat"], dec) + c["mins"] / 60.0
        d_node = (
            RG.node_shift(c["ring"], c["date"], lst, EPOCH) if c.get("prec") else 0.0
        )
        art = T.BORTLE[c.get("bortle", 1)]
        r = RG.evaluate(RG.build(c["ring"], ra), c["lat"], lst, dec, art, d_node)
        r.update(case=c, lst=lst, dec=dec, ra=ra, art=art, d_node=d_node)
        out.append(r)
    return out


JS = r"""
const fs = require("fs"), path = require("path");
const docs = process.argv[2];
const RG = require(path.join(docs, "rings.js"));
const cases = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const iso = d => d.map((x, i) => i ? String(x).padStart(2, "0") : String(x)).join("-");
const out = cases.map(r => {
  const c = r.case;
  const dNode = c.prec ? RG.nodeShift(c.ring, iso(c.date), r.lst, iso(r.epoch)) : 0;
  const e = RG.evaluate(RG.build(c.ring, r.ra, false),
                        { lat: c.lat, lst: r.lst, dec: r.dec, art: r.art, dNode: dNode });
  return { up: e.up, lit: e.lit, visible: e.visible, best: e.best, d_node: dNode, sun_el: e.sunEl };
});
console.log(JSON.stringify(out));
"""


def main():
    py = python_side()
    with tempfile.TemporaryDirectory() as tmp:
        cases_f, js_f = os.path.join(tmp, "cases.json"), os.path.join(tmp, "run.js")
        with open(cases_f, "w") as f:
            json.dump(
                [
                    dict(
                        case=r["case"],
                        lst=r["lst"],
                        dec=r["dec"],
                        ra=r["ra"],
                        art=r["art"],
                        epoch=EPOCH,
                    )
                    for r in py
                ],
                f,
            )
        with open(js_f, "w") as f:
            f.write(JS)
        res = subprocess.run(
            ["node", js_f, os.path.join(HERE, "docs"), cases_f],
            capture_output=True,
            text=True,
            check=True,
        )
        js = json.loads(res.stdout)

    bad = 0
    print(
        "%-44s %-8s %10s %10s %9s" % ("case", "quantity", "python", "browser", "diff")
    )
    for p, j in zip(py, js):
        c, rg = p["case"], p["case"]["ring"]
        tag = "%gkm i%g O%g w%g %04d-%02d-%02d %5.1f %3dmin%s%s" % (
            rg["alt"],
            rg["inc"],
            rg["raan"],
            rg["width"],
            *c["date"],
            c["lat"],
            c["mins"],
            " B%d" % c["bortle"] if "bortle" in c else "",
            " J2" if c.get("prec") else "",
        )
        for k, tol in (
            ("up", MAX_ARC),
            ("lit", MAX_ARC),
            ("visible", MAX_ARC),
            ("d_node", 1e-9),
            ("sun_el", 1e-9),
        ):
            diff = j[k] - p[k]
            flag = "" if abs(diff) <= tol else "  <-- MISMATCH"
            bad += bool(flag)
            print("%-44s %-8s %10.4f %10.4f %9.1e%s" % (tag, k, p[k], j[k], diff, flag))
            tag = ""
        a, b = p["best"], j["best"]
        if (a is None) != (b is None) or (a is not None and abs(a - b) > MAX_MAG):
            print("%-44s %-8s %10s %10s  <-- MISMATCH" % ("", "best", a, b))
            bad += 1
        else:
            print(
                "%-44s %-8s %10s %10s"
                % (
                    "",
                    "best",
                    "-" if a is None else "%.4f" % a,
                    "-" if b is None else "%.4f" % b,
                )
            )
    print("\n%d cases, %d mismatches" % (len(CASES), bad))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

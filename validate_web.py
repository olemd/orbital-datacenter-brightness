"""
Check the browser version against the Python, number for number.

Runs the same cases through both: the Python modules in this repository and
docs/physics.js under Node, loading the exported layout in docs/data.js. Every
count in the app should match what the Python prints for the same inputs.

    python3 validate_web.py          # needs node on the PATH

Exits non-zero if anything disagrees by more than MAX_DIFF satellites.
"""

import json
import os
import subprocess
import sys
import tempfile

import numpy as np

import lsm as L
import pano as P
import sky_view as SV
import solar
import skymodel as SK
import twilight as T

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_DIFF = 2          # satellites; floating-point ties at a threshold

CASES = []
for m in (0, 30, 45, 62, 70, 80, 106, 120, 150, 198):
    CASES.append(dict(date=(2026, 9, 22), lat=37.2, mins=m, dusk=True))
for m in (80, 92, 120, 200):
    CASES.append(dict(date=(2026, 12, 21), lat=37.2, mins=m, dusk=True))
CASES += [
    dict(date=(2026, 6, 21), lat=37.2, mins=80, dusk=True),
    dict(date=(2026, 9, 22), lat=37.2, mins=80, dusk=False),
    dict(date=(2026, 12, 21), lat=37.2, mins=100, dusk=False),
    dict(date=(2026, 9, 22), lat=37.2, mins=70, dusk=True, bortle=4),
    dict(date=(2026, 9, 22), lat=37.2, mins=70, dusk=True, bortle=8),
    dict(date=(2026, 9, 22), lat=37.2, mins=80, dusk=True, spread=30),
    dict(date=(2026, 12, 21), lat=37.2, mins=90, dusk=True, spread=30),
    dict(date=(2026, 9, 22), lat=37.2, mins=70, dusk=True, n_sats=100000),
    dict(date=(2026, 12, 21), lat=55.0, mins=90, dusk=True),
    dict(date=(2026, 12, 21), lat=-33.9, mins=80, dusk=True),
    dict(date=(2027, 3, 1), lat=51.5, mins=75, dusk=True, bortle=5),
]


def python_side():
    cons_by_spread = {}
    out = []
    for c in CASES:
        spread = c.get("spread", 10)
        if spread not in cons_by_spread:
            cons_by_spread[spread] = L.build_sso(500_000, relax_deg=float(spread))
        base = cons_by_spread[spread]
        cons, scale = SV.subsample(base, c.get("n_sats", 500_000))
        y, mo, d = c["date"]
        bortle = c.get("bortle", 1)
        dec, ra = solar.sun(y, mo, d)
        ss = solar.sunset_lst(c["lat"], dec)
        ref = ss if c["dusk"] else solar.sunrise_lst(c["lat"], dec)
        signed = c["mins"] if c["dusk"] else -c["mins"]
        lst = ref + signed / 60.0
        r = dict(case=c, lst=lst, dec=dec, ra=ra)
        for model in ("boley", "mini"):
            r["whole_" + model] = SV.whole_sky_count(
                cons, scale, y, mo, d, c["lat"], c["mins"], c["dusk"], bortle, model)
            sat, star = P.visible_altaz(cons, c["lat"], dec, ra, ref, signed,
                                        90.0, bortle, model)
            r["drawn_" + model] = len(sat[0]) * scale
            r["drawn_stars"] = len(star[0])
            r["ring90_" + model] = SV.ring_azimuth(
                cons, y, mo, d, c["lat"], c["mins"], c["dusk"], model, bortle, 90.0)
        r["stars"] = SV.star_counts_zenith(c["lat"], dec, ra, ref, signed, bortle)[1]
        r["sun_el"] = float(L.sun_elevation(c["lat"], lst, dec))
        out.append(r)
    return out


JS = r"""
const fs = require("fs"), vm = require("vm"), path = require("path");
const docs = process.argv[2];
const ODC = require(path.join(docs, "physics.js"));
const box = { window: {} };
vm.runInNewContext(fs.readFileSync(path.join(docs, "data.js"), "utf8"), box);
const man = box.window.ODC_MANIFEST, buf = ODC.decodeBase64(box.window.ODC_BLOB);
const stars = ODC.loadStars(man, buf);
const consBy = {};
const cases = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const out = [];
for (const r of cases) {
  const c = r.case, spread = String(c.spread || 10);
  if (!consBy[spread]) consBy[spread] = ODC.loadConstellation(man, buf, spread);
  const cons = consBy[spread];
  const sub = ODC.subsample(cons, c.n_sats || 500000);
  const art = ODC.BORTLE[c.bortle || 1];
  const opts = { lat: c.lat, lst: r.lst, dec: r.dec, t: 0, art: art, sub: sub, local: true };
  const t0 = Date.now();
  const e = ODC.evaluate(cons, opts);
  const ms = Date.now() - t0;
  const st = ODC.evaluateStars(stars, { lat: c.lat, lst: r.lst, dec: r.dec, raSun: r.ra, art: art });
  out.push({
    whole_boley: e.count.boley, whole_mini: e.count.mini,
    drawn_boley: e.draw.boley.n / 4 * e.scale, drawn_mini: e.draw.mini.n / 4 * e.scale,
    drawn_stars: st.draw.n / 4, stars: st.count, sun_el: e.sunEl,
    ring90_boley: ODC.ringAzimuth(e.hist.boley, 90), ring90_mini: ODC.ringAzimuth(e.hist.mini, 90),
    ms: ms
  });
}
console.log(JSON.stringify(out));
"""


def main():
    py = python_side()
    with tempfile.TemporaryDirectory() as tmp:
        cases_f = os.path.join(tmp, "cases.json")
        js_f = os.path.join(tmp, "run.js")
        with open(cases_f, "w") as f:
            json.dump([{k: v for k, v in r.items() if k in ("case", "lst", "dec", "ra")}
                       for r in py], f)
        with open(js_f, "w") as f:
            f.write(JS)
        res = subprocess.run(["node", js_f, os.path.join(HERE, "docs"), cases_f],
                             capture_output=True, text=True, check=True)
        js = json.loads(res.stdout)

    keys = ("whole_boley", "whole_mini", "drawn_boley", "drawn_mini", "stars",
            "drawn_stars")
    worst, bad = 0.0, 0
    print("%-34s %-12s %9s %9s %6s" % ("case", "quantity", "python", "browser", "diff"))
    for p, j in zip(py, js):
        c = p["case"]
        tag = "%04d-%02d-%02d %5.1fN %3d min %s%s%s%s" % (
            *c["date"], c["lat"], c["mins"], "eve" if c["dusk"] else "mrn",
            " B%d" % c["bortle"] if "bortle" in c else "",
            " sp%d" % c["spread"] if "spread" in c else "",
            " n%dk" % (c["n_sats"] // 1000) if "n_sats" in c else "")
        for k in keys:
            diff = j[k] - p[k]
            worst = max(worst, abs(diff))
            flag = "" if abs(diff) <= MAX_DIFF else "  <-- MISMATCH"
            bad += bool(flag)
            print("%-34s %-12s %9.0f %9.0f %6.0f%s" % (tag, k, p[k], j[k], diff, flag))
            tag = ""
        for m in ("boley", "mini"):
            a, b = p["ring90_" + m], j["ring90_" + m]
            if (a is None) != (b is None) or (a is not None and abs(a - b) > 2.01):
                print("%-34s %-12s %9s %9s  <-- MISMATCH" % ("", "ring90_" + m, a, b))
                bad += 1
        if abs(p["sun_el"] - j["sun_el"]) > 1e-9:
            print("  sun elevation differs: %.12f vs %.12f" % (p["sun_el"], j["sun_el"]))
            bad += 1
    print("\nlargest disagreement: %.0f satellites or stars; %d mismatches"
          % (worst, bad))
    print("browser evaluate() time per instant: median %d ms under Node"
          % int(np.median([j["ms"] for j in js])))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()

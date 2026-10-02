// Tests for docs/rings.js. Run with: bun test
const { test, expect } = require("bun:test");
const P = require("../docs/physics.js");
const RG = require("../docs/rings.js");

const RING = { alt: 2000, inc: 0, raan: 0, width: 100, albedo: 0.2 };
const NIGHT = { lst: 21.0, dec: 0.0, art: null };       // 3 h after equinox sunset
const RA_SUN = 12.0;                                    // September equinox

function at(spec, lat, extra) {
  const ring = RG.build(spec, (extra && extra.raSun) ?? RA_SUN, true);
  return RG.evaluate(ring, Object.assign({ lat: lat }, NIGHT, extra || {}));
}

test("equatorial ring sets below the horizon past its cutoff latitude", () => {
  const cut = RG.equatorialMaxLat(RING.alt);
  expect(cut).toBeCloseTo(40.4, 1);                   // acos(6378 / 8378)
  expect(at(RING, cut - 2).up).toBeGreaterThan(0);
  expect(at(RING, cut + 2).up).toBe(0);
  expect(at(RING, -(cut - 2)).up).toBeGreaterThan(0); // symmetric north/south
});

test("node direction does not matter for an equatorial ring", () => {
  // Rotating the node only shifts where the samples fall around the
  // circle, so the sums agree to the coarse sample spacing (0.25 deg at
  // the shadow edges), not exactly.
  const a = at(RING, 20), b = at(Object.assign({}, RING, { raan: 123 }), 20);
  for (const k of ["up", "lit", "visible"]) expect(Math.abs(b[k] - a[k])).toBeLessThan(0.5);
});

test("Earth's shadow hides the overhead part at midnight but not at dusk", () => {
  const low = Object.assign({}, RING, { alt: 500 });
  const midnight = at(low, 0, { lst: 24.0 });
  expect(midnight.up).toBeGreaterThan(0);
  expect(midnight.lit).toBe(0);                       // all of it in the umbra
  const dusk = at(low, 0, { lst: 19.0 });
  expect(dusk.lit).toBeGreaterThan(0);
  expect(dusk.lit).toBeLessThan(dusk.up);             // part lit, part shadowed
});

test("a bright, wide ring is visible at night and nothing shows in daylight", () => {
  expect(at(RING, 20).visible).toBeGreaterThan(10);
  expect(at(RING, 20, { lst: 12.0 }).visible).toBe(0);
});

test("a polar ring reaches latitudes an equatorial ring cannot", () => {
  const polar = Object.assign({}, RING, { inc: 90, raan: 0 });
  expect(at(RING, 70).up).toBe(0);
  expect(at(polar, 70).up).toBeGreaterThan(0);
});

test("an inclined ring is fixed against the stars", () => {
  // Same local sidereal time (raSun + lst) on different days: same sky.
  const tilted = { alt: 3000, inc: 50, raan: 200, width: 100, albedo: 0.2 };
  const a = at(tilted, 45, { raSun: 12.0, lst: 3.0 });
  const b = at(tilted, 45, { raSun: 10.0, lst: 5.0 });
  expect(a.up).toBeGreaterThan(0);
  expect(b.up).toBeCloseTo(a.up, 6);
  // ...and a different sidereal time moves it
  const c = at(tilted, 45, { raSun: 12.0, lst: 5.0 });
  expect(Math.abs(c.up - a.up)).toBeGreaterThan(1);
});

test("doubling the area brightens a piece by 2.5 log10(2)", () => {
  const m1 = RG.pieceMag(0.2, 1000, 50, 2000, 1.0, 1.0);
  const m2 = RG.pieceMag(0.2, 1000, 100, 2000, 1.0, 1.0);
  expect(m1 - m2).toBeCloseTo(2.5 * Math.log10(2), 9);
});

test("input outside the limits is clamped, not trusted", () => {
  const s = RG.sanitize({ alt: -5, inc: 999, raan: "x", width: 1e9, albedo: 2 });
  expect(s).toEqual({ alt: 100, inc: 180, raan: 0, width: 100000, albedo: 1 });
});

test("the path marks shadowed samples and breaks below the horizon", () => {
  const low = Object.assign({}, RING, { alt: 500 });
  const ring = RG.build(low, RA_SUN, true);
  const p = RG.path(ring, 0, 24.0, 0.0);              // midnight: up, but dark
  expect(p.length).toBe(4 * ring.n);
  let up = 0, lit = 0;
  for (let i = 0; i < p.length; i += 4) if (!isNaN(p[i])) { up++; lit += p[i + 3]; }
  expect(up).toBeGreaterThan(0);
  expect(lit).toBe(0);
});

test("visible samples are packed for drawing with unit directions", () => {
  const ring = RG.build(RING, RA_SUN, false);
  const r = RG.evaluate(ring, Object.assign({ lat: 20, local: true }, NIGHT));
  expect(r.draw.length % 4).toBe(0);
  expect(r.draw.length).toBeGreaterThan(0);
  const n = Math.hypot(r.draw[0], r.draw[1], r.draw[2]);
  expect(n).toBeCloseTo(1, 4);
  expect(P.limitingMag(21.75)).toBeGreaterThan(6);    // sanity: shared sky model loaded
});

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
  const s = RG.sanitize({ alt: -5, inc: 999, raan: "x", width: 1e9, albedo: 2,
                          fix: 0.7, lon: 400, stations: 99.4, stSize: 0, cable: -1 });
  expect(s).toEqual({ alt: 100, inc: 180, raan: 0, width: 100000, albedo: 1,
                      fix: 1, lon: 180, stations: 24, stSize: 1, cable: 0 });
});

test("specs from before the ground-fixed fields existed get their defaults", () => {
  const s = RG.sanitize({ alt: 2000, inc: 45, raan: 10, width: 100, albedo: 0.2 });
  expect(s.fix).toBe(0);
  expect(s.stations).toBe(0);
  expect(s.stSize).toBe(RG.DEFAULTS.stSize);
  expect(s.cable).toBe(RG.DEFAULTS.cable);
});

test("the path marks shadowed samples and breaks below the horizon", () => {
  const low = Object.assign({}, RING, { alt: 500 });
  const ring = RG.build(low, RA_SUN, true);
  const p = RG.path(ring, 0, 24.0, 0.0).ring;         // midnight: up, but dark
  expect(p.length).toBe(4 * ring.n);
  let up = 0, lit = 0;
  for (let i = 0; i < p.length; i += 4) if (!isNaN(p[i])) { up++; lit += p[i + 3]; }
  expect(up).toBeGreaterThan(0);
  expect(lit).toBe(0);
});

test("visible samples are packed for drawing with unit directions", () => {
  const ring = RG.build(RING, RA_SUN, false);
  const r = RG.evaluate(ring, Object.assign({ lat: 20, local: true }, NIGHT));
  expect(r.draw.length % 5).toBe(0);
  expect(r.draw.length).toBeGreaterThan(0);
  const n = Math.hypot(r.draw[0], r.draw[1], r.draw[2]);
  expect(n).toBeCloseTo(1, 4);
  // angular width: 100 m seen from at least 2,000 km is under 5e-5 rad
  expect(r.draw[4]).toBeGreaterThan(0);
  expect(r.draw[4]).toBeLessThan(100 / 2000e3);
  expect(P.limitingMag(21.75)).toBeGreaterThan(6);    // sanity: shared sky model loaded
});

test("J2 node drift matches the sun-synchronous rate", () => {
  // lsm.sso_inclination: the tilt whose drift is one turn per year
  const R_E = 6378.137, MU = 398600.4418, J2 = 1.08263e-3, alt = 800;
  const a = R_E + alt, n = Math.sqrt(MU / a ** 3), wp = 2 * Math.PI / (365.2422 * 86400);
  const inc = Math.acos(-2 * wp * a * a / (3 * J2 * n * R_E * R_E)) * 180 / Math.PI;
  const rate = RG.nodeRate({ alt: alt, inc: inc, raan: 0, width: 1, albedo: 0.2 });
  expect(rate).toBeCloseTo(360 / 365.2422, 6);
  // prograde rings regress, polar and equatorial rings do not drift in effect
  expect(RG.nodeRate(Object.assign({}, RING, { inc: 45 }))).toBeLessThan(0);
  expect(Math.abs(RG.nodeRate(Object.assign({}, RING, { inc: 90 })))).toBeLessThan(1e-12);
});

test("precessing by d degrees is the same as starting d degrees further on", () => {
  const tilted = { alt: 3000, inc: 50, raan: 200, width: 100, albedo: 0.2 };
  const opts = { lat: 45, lst: 3.0, dec: 0, art: null };
  const moved = RG.evaluate(RG.build(tilted, RA_SUN, true), Object.assign({ dNode: 37 }, opts));
  const built = RG.evaluate(RG.build(Object.assign({}, tilted, { raan: 237 }), RA_SUN, true), opts);
  for (const k of ["up", "lit", "visible"]) expect(Math.abs(moved[k] - built[k])).toBeLessThan(0.5);
  expect(moved.best).toBeCloseTo(built.best, 1);
});

test("node shift counts days from noon on the epoch", () => {
  const sp = { alt: 2000, inc: 45, raan: 0, width: 100, albedo: 0.2 };
  expect(RG.nodeShift(sp, "2026-03-20", 12.0, "2026-03-20")).toBeCloseTo(0, 12);
  expect(RG.nodeShift(sp, "2026-03-30", 12.0, "2026-03-20")).toBeCloseTo(10 * RG.nodeRate(sp), 9);
  // 6 am the next morning, written as lst 30 on the night's date
  expect(RG.nodeShift(sp, "2026-03-20", 30.0, "2026-03-20")).toBeCloseTo(0.75 * RG.nodeRate(sp), 9);
});

const BIRCH = { alt: 2000, inc: 45, raan: 0, width: 100, albedo: 0.2, fix: 1, lon: 30,
                stations: 4, stSize: 500, cable: 5 };

test("a ground-fixed equatorial ring is the same as a star-fixed one", () => {
  const ground = Object.assign({}, RING, { fix: 1, lon: 77 });
  const lst = 21.0;
  const a = RG.evaluate(RG.build(RING, RA_SUN, true), { lat: 20, lst: lst, dec: 0 });
  const b = RG.evaluate(RG.build(ground, RA_SUN, true),
                        { lat: 20, lst: lst, dec: 0, dNode: RG.nodeOffset(ground, "2026-09-22", lst, "2026-03-20", true) });
  for (const k of ["up", "lit", "visible"]) expect(Math.abs(b[k] - a[k])).toBeLessThan(0.5);
});

test("a ground-fixed ring holds still in the sky all night", () => {
  const ring = RG.build(BIRCH, RA_SUN, true);
  const at = lst => RG.path(ring, 20, lst, 0, RG.nodeOffset(BIRCH, "2026-09-22", lst, "2026-03-20", true));
  const a = at(19.0), b = at(27.0);                  // 7 pm and 3 am
  let maxd = 0;
  for (let i = 0; i < a.ring.length; i += 4) {
    if (isNaN(a.ring[i])) { expect(isNaN(b.ring[i])).toBe(true); continue; }
    for (let j = 0; j < 3; j++) maxd = Math.max(maxd, Math.abs(a.ring[i + j] - b.ring[i + j]));
  }
  expect(maxd).toBeLessThan(1e-9);
  // ...while a star-fixed ring with the same tilt moves
  const sky = Object.assign({}, BIRCH, { fix: 0 }), rs = RG.build(sky, RA_SUN, true);
  const c = RG.path(rs, 20, 19.0, 0, 0).ring, d = RG.path(rs, 20, 27.0, 0, 0).ring;
  let moved = 0;
  for (let i = 0; i < c.length; i += 4) if (isNaN(c[i]) !== isNaN(d[i])) moved++;
  expect(moved).toBeGreaterThan(10);
});

test("ground-fixed rings ignore the J2 switch; star-fixed ones follow it", () => {
  expect(RG.nodeOffset(BIRCH, "2026-09-22", 21, "2026-03-20", true))
    .toBe(RG.nodeOffset(BIRCH, "2026-09-22", 21, "2026-03-20", false));
  const sky = Object.assign({}, BIRCH, { fix: 0 });
  expect(RG.nodeOffset(sky, "2026-09-22", 21, "2026-03-20", false)).toBe(0);
  expect(RG.nodeOffset(sky, "2026-09-22", 21, "2026-03-20", true)).not.toBe(0);
});

test("stations sit on the ring and cables hang straight down to the ground", () => {
  const ring = RG.build(BIRCH, RA_SUN, false);
  expect(ring.nStations).toBe(4);
  const R_E = 6378.137;
  for (let q = 0; q < 4; q++) {
    const r = Math.hypot(ring.stations[3 * q], ring.stations[3 * q + 1], ring.stations[3 * q + 2]);
    expect(r).toBeCloseTo(R_E + 2000, 6);
  }
  const C = ring.cable;
  expect(C.n).toBe(4 * C.perCable);
  const foot = Math.hypot(C.pos[0], C.pos[1], C.pos[2]), top = 3 * (C.perCable - 1);
  expect(foot - R_E).toBeLessThan(1);
  expect(Math.hypot(C.pos[top], C.pos[top + 1], C.pos[top + 2]) - R_E).toBeGreaterThan(1990);
  // a star-fixed ring carries no stations, whatever the count says
  expect(RG.build(Object.assign({}, BIRCH, { fix: 0 }), RA_SUN, true).nStations).toBe(0);
  // and cable thickness 0 means no cables
  expect(RG.build(Object.assign({}, BIRCH, { cable: 0 }), RA_SUN, true).cable.n).toBe(0);
});

test("a station overhead at dusk is seen at the zenith, cables and all", () => {
  // equatorial ring, station at the node, node on our meridian, from the equator
  const sp = { alt: 2000, inc: 0, raan: 0, width: 100, albedo: 0.2, fix: 1, lon: 0,
               stations: 1, stSize: 500, cable: 50 };
  const lst = 19.0;
  const r = RG.evaluate(RG.build(sp, RA_SUN, false),
                        { lat: 0, lst: lst, dec: 0, local: true,
                          dNode: RG.nodeOffset(sp, "2026-09-22", lst, "2026-03-20", true) });
  expect(r.stations).toEqual({ total: 1, up: 1, lit: 1, visible: 1 });
  expect(r.stationDraw[2]).toBeCloseTo(1, 6);       // straight up
  expect(r.cable.up).toBeGreaterThan(0);            // seen end-on, but there
  expect(r.cable.lit).toBeLessThanOrEqual(r.cable.up);
});

/*
 * Orbital rings: physics for rings.html.
 *
 * A ring here is a megastructure in the sense of Paul Birch's orbital rings:
 * one continuous band circling the Earth, not a swarm of satellites. Each
 * ring is a circle of radius R_E + alt with a width and an albedo, in a plane
 * set by an inclination and the right ascension of its ascending node.
 *
 * Everything that is not about the ring itself comes from physics.js, the
 * port of this repository's Python: observer geometry, the Sun, the
 * cylindrical Earth shadow, airmass, the twilight sky over the dome and the
 * naked-eye limit. So a ring and a star on the same page are judged against
 * exactly the same sky.
 *
 * Geometry. physics.js works in a frame that turns with the Sun: x points at
 * the Sun's right ascension, z at the celestial pole, and the observer's
 * longitude is set by local solar time. A ring is fixed against the stars,
 * not the Sun, so its node goes in at longitude (RAAN - RA_sun) in that
 * frame, the same transform evaluateStars uses for stars. An equatorial ring
 * (inclination 0) is symmetric about the pole and looks identical all night;
 * only Earth's shadow moves along it. An inclined ring wheels across the sky
 * with the stars. Nodal precession, which a real ring would need to manage,
 * is not modelled: the node stays where you put it.
 *
 * Brightness. Each sample stands for a piece of ring of length L and width
 * w, and its magnitude comes from Boley, Lawler & Rein (2026) eq 2, the
 * Lambertian reflector the satellite page uses, with zeta = albedo * L * w.
 * That treats each piece as a diffuse reflector of that area, which is a
 * first approximation: it ignores the real shape and any specular glint.
 *
 * Visibility. The eye does not see a line by its total brightness but by
 * how much light lands in one resolution element. So a ring counts as
 * visible where a patch about one arcminute long (and at most one
 * arcminute wide, for rings wide enough to resolve) beats the naked-eye
 * limit against the local sky. This treats the patch as a point source,
 * which is conservative: the eye integrates along a line somewhat, so faint
 * rings may be a little easier to see than this says.
 *
 * Works in a browser (window.RINGS) and in Node or Bun (require).
 */
(function (root) {
  "use strict";

  var ODC = (typeof module !== "undefined" && module.exports) ? require("./physics.js") : root.ODC;
  var DEG = ODC.DEG, R_E = ODC.R_E, K_EXT = ODC.K_EXT;
  var V_SUN = -26.77;                     // Boley et al. solar constant term
  var EYE = DEG / 60.0;                   // naked-eye resolution, 1 arcminute
  var MIN_SIN_BETA = 0.05;                // cap the along-the-line pile-up

  // Sampling. Points are spaced so that, seen from directly below, adjacent
  // samples are FINE_SPACING apart on the sky: close enough to merge into a
  // continuous line on screen. The coarse set is for the night curve, where
  // only arc lengths are needed and those converge much sooner.
  var FINE_SPACING = 0.025 * DEG, COARSE_SPACING = 0.25 * DEG;
  var MIN_SAMPLES = 3600, MAX_SAMPLES = 600000;

  // Sensible bounds for user input, also enforced when reading the URL.
  var LIMITS = {
    alt: [100, 40000], inc: [0, 180], raan: [0, 360], width: [0.1, 100000], albedo: [0.01, 1]
  };

  function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /** Clamp a ring spec to LIMITS; returns a new object. */
  function sanitize(spec) {
    var out = {};
    Object.keys(LIMITS).forEach(function (k) {
      var v = Number(spec[k]);
      out[k] = isFinite(v) ? clip(v, LIMITS[k][0], LIMITS[k][1]) : LIMITS[k][0];
    });
    return out;
  }

  /**
   * Sample one ring for a date. raSunHr is the Sun's right ascension in
   * hours (physics.sun), which places the ring's node against the stars.
   * coarse picks the cheap sampling used for the night curve.
   */
  function build(spec, raSunHr, coarse) {
    var sp = sanitize(spec);
    var a = R_E + sp.alt;
    var spacing = coarse ? COARSE_SPACING : FINE_SPACING;
    var n = Math.round(clip(Math.ceil(2 * Math.PI * a / (sp.alt * spacing)), MIN_SAMPLES, MAX_SAMPLES));
    var lam = (sp.raan - 15.0 * raSunHr) * DEG, inc = sp.inc * DEG;
    var node = [Math.cos(lam), Math.sin(lam), 0];
    // h = cos(i) z + sin(i) (z x node), as in lsm.build; m = h x node
    var zxn = [-node[1], node[0], 0];
    var h = [Math.sin(inc) * zxn[0], Math.sin(inc) * zxn[1], Math.cos(inc)];
    var m = [h[1] * node[2] - h[2] * node[1], h[2] * node[0] - h[0] * node[2],
             h[0] * node[1] - h[1] * node[0]];
    var pos = new Float64Array(3 * n), tan = new Float64Array(3 * n);
    for (var k = 0; k < n; k++) {
      var th = 2 * Math.PI * k / n, c = Math.cos(th), s = Math.sin(th);
      for (var j = 0; j < 3; j++) {
        pos[3 * k + j] = a * (c * node[j] + s * m[j]);
        tan[3 * k + j] = -s * node[j] + c * m[j];
      }
    }
    return { spec: sp, a: a, n: n, ds: 2 * Math.PI * a / n, pos: pos, tan: tan };
  }

  /**
   * Magnitude of a ring piece of length L_m by width w_m (metres) at range
   * d_km, phase angle phi and airmass X. Boley et al. eq 2 with
   * zeta = albedo * L * w.
   */
  function pieceMag(albedo, L_m, w_m, d_km, phi, X) {
    var g = (Math.PI - phi) * Math.cos(phi) + Math.sin(phi);
    var inner = (2.0 * albedo * L_m * w_m / (3.0 * Math.PI * Math.PI)) * g;
    return V_SUN - 2.5 * Math.log10(Math.max(inner, 1e-300)) + 5.0 * Math.log10(d_km * 1e3) + K_EXT * X;
  }

  /**
   * One ring at one instant.
   *
   * opts: { lat, lst, dec, art (Bortle skyglow or null), local (bool: also
   *         return the visible samples for drawing) }
   *
   * Arc lengths are angles on the sky, in degrees, summed over samples:
   *   up       ring above the horizon
   *   lit      of that, in sunlight
   *   visible  of that, bright enough to see against the local sky
   * best is the brightest one-arcminute patch that is visible (magnitude),
   * with its direction in east/north/up for aiming. draw, if local, packs
   * [east, north, up, V] per visible sample, where V is for the sample's own
   * length so the drawn line carries the right total light.
   */
  function evaluate(ring, opts) {
    var o = ODC.observer(opts.lat, opts.lst), s = ODC.sunDir(opts.dec);
    var sunEl = Math.asin(clip(s[0] * o.up[0] + s[1] * o.up[1] + s[2] * o.up[2], -1, 1)) / DEG;
    var art = (opts.art === undefined) ? null : opts.art;
    var ctx = ODC.skyContext(sunEl, art);
    var sp = ring.spec, P = ring.pos, T = ring.tan, n = ring.n, ds = ring.ds;
    var ox = o.r[0], oy = o.r[1], oz = o.r[2];
    var ux = o.up[0], uy = o.up[1], uz = o.up[2];
    var ex = o.east[0], ey = o.east[1], ez = o.east[2];
    var nx = o.north[0], ny = o.north[1], nz = o.north[2];
    var sx = s[0], sy = s[1], sz = s[2];
    var local = !!opts.local;
    var up = 0, lit = 0, vis = 0, best = null, bestDir = null;
    var draw = local ? [] : null;

    for (var k = 0; k < n; k++) {
      var b = 3 * k, px = P[b], py = P[b + 1], pz = P[b + 2];
      var rx = px - ox, ry = py - oy, rz = pz - oz;
      if (!(rx * ux + ry * uy + rz * uz > 0)) continue;          // below the horizon
      var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      var vx = rx / d, vy = ry / d, vz = rz / d;
      // angle between the line of sight and the ring: a ring seen end-on
      // packs more length into each arcminute of sky
      var tx = T[b], ty = T[b + 1], tz = T[b + 2];
      var cx = vy * tz - vz * ty, cy = vz * tx - vx * tz, cz = vx * ty - vy * tx;
      var sinBeta = Math.max(Math.sqrt(cx * cx + cy * cy + cz * cz), MIN_SIN_BETA);
      var ang = ds * sinBeta / d / DEG;
      up += ang;
      // cylindrical umbra, as lsm.sunlit
      var along = px * sx + py * sy + pz * sz;
      if (!(along > 0)) {
        var qx = px - along * sx, qy = py - along * sy, qz = pz - along * sz;
        if (!(Math.sqrt(qx * qx + qy * qy + qz * qz) > R_E)) continue;
      }
      lit += ang;
      var sinAlt = vx * ux + vy * uy + vz * uz;
      var alt = Math.asin(clip(sinAlt, -1, 1));
      var cosphi = clip(-(vx * sx + vy * sy + vz * sz), -1, 1);
      var phi = Math.acos(cosphi);
      var X = ODC.airmassLSM(alt);
      var Leye = d * 1e3 * EYE / sinBeta, weye = Math.min(sp.width, d * 1e3 * EYE);
      var Veye = pieceMag(sp.albedo, Leye, weye, d, phi, X);
      var lim = ODC.limitingMag(ODC.skyAt(alt, Math.acos(-cosphi) / DEG, ctx));
      if (!(Veye < lim)) continue;
      vis += ang;
      var dE = vx * ex + vy * ey + vz * ez, dN = vx * nx + vy * ny + vz * nz;
      if (best === null || Veye < best) { best = Veye; bestDir = [dE, dN, sinAlt]; }
      if (local) draw.push(dE, dN, sinAlt, pieceMag(sp.albedo, ds * 1e3, sp.width, d, phi, X));
    }
    return {
      sunEl: sunEl, up: up, lit: lit, visible: vis, best: best, bestDir: bestDir,
      draw: local ? new Float32Array(draw) : null
    };
  }

  /**
   * Where the ring is, visible or not: [east, north, up, lit] for every
   * sample above the horizon, in ring order, so the caller can draw the
   * path and show which part Earth's shadow covers. Use a coarse ring.
   */
  function path(ring, lat, lst, dec) {
    var o = ODC.observer(lat, lst), s = ODC.sunDir(dec), P = ring.pos, out = [];
    for (var k = 0; k < ring.n; k++) {
      var px = P[3 * k], py = P[3 * k + 1], pz = P[3 * k + 2];
      var rx = px - o.r[0], ry = py - o.r[1], rz = pz - o.r[2];
      var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      var dU = (rx * o.up[0] + ry * o.up[1] + rz * o.up[2]) / d;
      if (!(dU > 0)) { out.push(NaN, NaN, NaN, 0); continue; }   // NaN breaks the line
      var along = px * s[0] + py * s[1] + pz * s[2], lit = 1;
      if (!(along > 0)) {
        var qx = px - along * s[0], qy = py - along * s[1], qz = pz - along * s[2];
        lit = Math.sqrt(qx * qx + qy * qy + qz * qz) > R_E ? 1 : 0;
      }
      out.push((rx * o.east[0] + ry * o.east[1] + rz * o.east[2]) / d,
               (rx * o.north[0] + ry * o.north[1] + rz * o.north[2]) / d, dU, lit);
    }
    return out;
  }

  /**
   * Highest latitude from which an EQUATORIAL ring of this altitude rises
   * above the horizon at all, degrees: cos(lat) = R_E / (R_E + alt).
   */
  function equatorialMaxLat(altKm) {
    return Math.acos(R_E / (R_E + altKm)) / DEG;
  }

  var api = {
    LIMITS: LIMITS, EYE: EYE, sanitize: sanitize, build: build, evaluate: evaluate,
    pieceMag: pieceMag, path: path, equatorialMaxLat: equatorialMaxLat
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RINGS = api;
})(typeof window !== "undefined" ? window : this);

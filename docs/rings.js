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
 * with the stars.
 *
 * Precession. The Earth's equatorial bulge (J2) turns a tilted ring's plane
 * about the pole. For material moving at orbital speed the node drifts at
 *
 *     dRAAN/dt = -1.5 n J2 (R_E / a)^2 cos(i)
 *
 * the same rate that makes lsm.sso_inclination sun-synchronous. That is a
 * few degrees a day for low rings, so over a season it moves a ring right
 * across the sky. A Birch ring's rotor moves faster than orbital speed and
 * would precess differently, and an active ring could hold its node, so the
 * page lets you turn this off. Precession is a rotation about the pole, so
 * it is applied by turning the observer and Sun the other way (nodeShift,
 * opts.dNode) rather than rebuilding the ring.
 *
 * Ground-fixed rings. Birch's design does not leave a tilted ring to drift:
 * "By precessing the ring once every 24 hours, the Orbital Ring will hover
 * above any meridian selected on the surface of Earth" (Wikipedia, Orbital
 * ring), and its stations "stay in one place above some designated point on
 * Earth". A ring with fix = 1 is that: its node is given as a longitude east
 * of the observer and it turns with the Earth, so it holds still in your sky
 * all night and only Earth's shadow moves along it. That precession is
 * driven, so J2 does not apply. No real longitude is needed, only the offset.
 *
 * Stations and elevator cables. A ground-fixed ring can carry stations,
 * spaced evenly around it from the node, each a diffuse reflector of area
 * stSize^2 seen as a point source. From each hangs an elevator cable
 * straight down to the ground ("Hanging down from these ring stations are
 * short elevator cables"), treated as a line exactly like the ring, with
 * its own thickness. Station shape, cable taper and the dimensions are not
 * given anywhere authoritative; they are inputs.
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
  var MU = 398600.4418, J2 = 1.08263e-3;  // as lsm.py
  var EYE = DEG / 60.0;                   // naked-eye resolution, 1 arcminute
  var MIN_SIN_BETA = 0.05;                // cap the along-the-line pile-up

  // Sampling. Points are spaced so that, seen from directly below, adjacent
  // samples are FINE_SPACING apart on the sky: close enough to merge into a
  // continuous line on screen. The coarse set is for the night curve, where
  // only arc lengths are needed and those converge much sooner.
  var FINE_SPACING = 0.025 * DEG, COARSE_SPACING = 0.25 * DEG;
  var MIN_SAMPLES = 3600, MAX_SAMPLES = 600000;
  // Elevator cables run from CABLE_FOOT km up to the ring, sampled every
  // CABLE_STEP km (fine) or CABLE_STEP_COARSE km.
  var CABLE_FOOT = 0.5, CABLE_STEP = 0.25, CABLE_STEP_COARSE = 5.0;
  var CABLE_MIN = 200, CABLE_MAX = 8000;

  // Sensible bounds for user input, also enforced when reading the URL.
  //   fix       0: plane fixed against the stars; 1: fixed to the ground
  //   lon       ground-fixed node, degrees of longitude east of the observer
  //   stations  ground-fixed only: stations spaced evenly from the node
  //   stSize    station size, metres (reflecting area stSize^2)
  //   cable     elevator cable thickness, metres; 0 for no cables
  var LIMITS = {
    alt: [100, 40000], inc: [0, 180], raan: [0, 360], width: [0.1, 100000], albedo: [0.01, 1],
    fix: [0, 1], lon: [-180, 180], stations: [0, 24], stSize: [1, 20000], cable: [0, 1000]
  };
  var INTEGER = { fix: true, stations: true };
  // What a field means when it is missing, e.g. in a link made before the
  // field existed. Anything else missing falls back to its lower limit.
  var DEFAULTS = { fix: 0, lon: 0, stations: 0, stSize: 500, cable: 2 };

  function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  /** Clamp a ring spec to LIMITS; returns a new object. */
  function sanitize(spec) {
    var out = {};
    Object.keys(LIMITS).forEach(function (k) {
      var raw = spec[k], v = Number(raw);
      if ((raw === undefined || raw === null || raw === "" || !isFinite(v)) && k in DEFAULTS) v = DEFAULTS[k];
      v = isFinite(v) ? clip(v, LIMITS[k][0], LIMITS[k][1]) : LIMITS[k][0];
      out[k] = INTEGER[k] ? Math.round(v) : v;
    });
    return out;
  }

  /**
   * Sample one ring for a date: the ring itself and, for a ground-fixed ring
   * with stations, the stations and their elevator cables.
   *
   * The node is placed in physics.js's Sun-fixed frame. A star-fixed ring
   * goes in at longitude (RAAN - RA_sun), with raSunHr the Sun's right
   * ascension in hours. A ground-fixed ring is built with its node at
   * longitude `lon` and then turned to the observer at each instant by
   * nodeOffset (the observer sits at longitude (lst - 12) * 15 in this
   * frame), so it stays over the same ground. coarse picks the cheap
   * sampling used for the night curve.
   */
  function build(spec, raSunHr, coarse) {
    var sp = sanitize(spec);
    var a = R_E + sp.alt;
    var spacing = coarse ? COARSE_SPACING : FINE_SPACING;
    var n = Math.round(clip(Math.ceil(2 * Math.PI * a / (sp.alt * spacing)), MIN_SAMPLES, MAX_SAMPLES));
    var lam = (sp.fix ? sp.lon : sp.raan - 15.0 * raSunHr) * DEG, inc = sp.inc * DEG;
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

    // Stations, evenly spaced around the ring from the node, and a cable
    // hanging straight down (radially) from each to the ground.
    var ns = sp.fix ? sp.stations : 0;
    var st = new Float64Array(3 * ns);
    var step = coarse ? CABLE_STEP_COARSE : CABLE_STEP;
    var nc = (ns && sp.cable > 0) ? Math.round(clip(Math.ceil((sp.alt - CABLE_FOOT) / step), CABLE_MIN, CABLE_MAX)) : 0;
    var cpos = new Float64Array(3 * ns * nc), ctan = new Float64Array(3 * ns * nc);
    var cds = nc ? (sp.alt - CABLE_FOOT) / nc : 0;
    for (var q = 0; q < ns; q++) {
      var tq = 2 * Math.PI * q / ns, cq = Math.cos(tq), sq = Math.sin(tq);
      var u = [cq * node[0] + sq * m[0], cq * node[1] + sq * m[1], cq * node[2] + sq * m[2]];
      for (var jj = 0; jj < 3; jj++) st[3 * q + jj] = a * u[jj];
      for (var kc = 0; kc < nc; kc++) {
        var r = R_E + CABLE_FOOT + (kc + 0.5) * cds, b = 3 * (q * nc + kc);
        for (var j3 = 0; j3 < 3; j3++) { cpos[b + j3] = r * u[j3]; ctan[b + j3] = u[j3]; }
      }
    }
    return {
      spec: sp, a: a, n: n, ds: 2 * Math.PI * a / n, pos: pos, tan: tan,
      stations: st, nStations: ns,
      cable: { n: ns * nc, perCable: nc, ds: cds, pos: cpos, tan: ctan }
    };
  }

  /** Node drift from J2, degrees per day, for material at orbital speed. */
  function nodeRate(spec) {
    var sp = sanitize(spec), a = R_E + sp.alt, n = Math.sqrt(MU / (a * a * a));
    return -1.5 * n * J2 * (R_E / a) * (R_E / a) * Math.cos(sp.inc * DEG) * 86400.0 / DEG;
  }

  // Days since J2000 at noon of a "YYYY-MM-DD" date, as solar.py does it.
  function dayNumber(iso) {
    var p = iso.split("-").map(Number), y = p[0], m = p[1], d = p[2];
    var a = Math.floor((14 - m) / 12), yy = y + 4800 - a, mm = m + 12 * a - 3;
    var jdn = d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4)
      - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
    return jdn - 2451545.0 + 0.5;
  }

  /**
   * How far the node has drifted, degrees, from local solar noon on the
   * epoch date to local solar time lstHr on dateIso. The RAAN you type is
   * the node at the epoch. lstHr may run past 24 into the next morning.
   */
  function nodeShift(spec, dateIso, lstHr, epochIso) {
    var days = dayNumber(dateIso) + (lstHr - 12.0) / 24.0 - dayNumber(epochIso);
    return nodeRate(spec) * days;
  }

  /**
   * The rotation about the pole to pass to evaluate/path as dNode, degrees.
   * Ground-fixed: the observer's longitude in the Sun-fixed frame, so the
   * ring turns with the Earth (the once-a-day precession of Birch's rings,
   * which is driven, so J2 does not enter). Star-fixed: the J2 drift if
   * prec, else nothing.
   */
  function nodeOffset(spec, dateIso, lstHr, epochIso, prec) {
    var sp = sanitize(spec);
    if (sp.fix) return (lstHr - 12.0) * 15.0;
    return prec ? nodeShift(sp, dateIso, lstHr, epochIso) : 0;
  }

  // Turn a vector about the pole (z) by ang radians.
  function rotZ(v, ang) {
    var c = Math.cos(ang), s = Math.sin(ang);
    return [c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]];
  }

  /**
   * Observer and Sun in the ring's own frame. A ring whose node has moved by
   * dNode degrees looks, to the observer, exactly like the unmoved ring seen
   * by an observer and Sun turned by -dNode about the pole. East/north/up
   * turn with the observer, so directions come out in the true local frame.
   */
  function frame(lat, lst, dec, dNode) {
    var o = ODC.observer(lat, lst), s = ODC.sunDir(dec), a = -(dNode || 0) * DEG;
    if (a === 0) return { o: o, s: s };
    return {
      o: { r: rotZ(o.r, a), up: rotZ(o.up, a), east: rotZ(o.east, a), north: rotZ(o.north, a) },
      s: rotZ(s, a)
    };
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

  // Everything one instant needs, in flat variables for the inner loops.
  function scene(opts) {
    var f = frame(opts.lat, opts.lst, opts.dec, opts.dNode), o = f.o, s = f.s;
    var sunEl = Math.asin(clip(s[0] * o.up[0] + s[1] * o.up[1] + s[2] * o.up[2], -1, 1)) / DEG;
    var art = (opts.art === undefined) ? null : opts.art;
    return { o: o, s: s, sunEl: sunEl, ctx: ODC.skyContext(sunEl, art) };
  }

  function isLit(px, py, pz, s) {
    var along = px * s[0] + py * s[1] + pz * s[2];
    if (along > 0) return true;
    var qx = px - along * s[0], qy = py - along * s[1], qz = pz - along * s[2];
    return Math.sqrt(qx * qx + qy * qy + qz * qz) > R_E;
  }

  /**
   * Scan one set of line samples (the ring, or the cables): positions P and
   * unit tangents T, n samples of length ds km, width w metres. Adds arc
   * lengths into acc and visible samples into draw.
   */
  function scanLine(sc, P, T, n, ds, w, albedo, acc, draw) {
    var o = sc.o, s = sc.s, ctx = sc.ctx;
    var ox = o.r[0], oy = o.r[1], oz = o.r[2];
    var ux = o.up[0], uy = o.up[1], uz = o.up[2];
    var ex = o.east[0], ey = o.east[1], ez = o.east[2];
    var nx = o.north[0], ny = o.north[1], nz = o.north[2];
    var sx = s[0], sy = s[1], sz = s[2];
    for (var k = 0; k < n; k++) {
      var b = 3 * k, px = P[b], py = P[b + 1], pz = P[b + 2];
      var rx = px - ox, ry = py - oy, rz = pz - oz;
      if (!(rx * ux + ry * uy + rz * uz > 0)) continue;          // below the horizon
      var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      var vx = rx / d, vy = ry / d, vz = rz / d;
      // angle between the line of sight and the line: one seen end-on
      // packs more length into each arcminute of sky
      var tx = T[b], ty = T[b + 1], tz = T[b + 2];
      var cx = vy * tz - vz * ty, cy = vz * tx - vx * tz, cz = vx * ty - vy * tx;
      var sinBeta = Math.max(Math.sqrt(cx * cx + cy * cy + cz * cz), MIN_SIN_BETA);
      var ang = ds * sinBeta / d / DEG;
      acc.up += ang;
      if (!isLit(px, py, pz, s)) continue;                       // cylindrical umbra, as lsm.sunlit
      acc.lit += ang;
      var sinAlt = vx * ux + vy * uy + vz * uz;
      var alt = Math.asin(clip(sinAlt, -1, 1));
      var cosphi = clip(-(vx * sx + vy * sy + vz * sz), -1, 1);
      var phi = Math.acos(cosphi);
      var X = ODC.airmassLSM(alt);
      var Leye = d * 1e3 * EYE / sinBeta, weye = Math.min(w, d * 1e3 * EYE);
      var Veye = pieceMag(albedo, Leye, weye, d, phi, X);
      var lim = ODC.limitingMag(ODC.skyAt(alt, Math.acos(-cosphi) / DEG, ctx));
      if (!(Veye < lim)) continue;
      acc.visible += ang;
      var dE = vx * ex + vy * ey + vz * ez, dN = vx * nx + vy * ny + vz * nz;
      if (acc.best === null || Veye < acc.best) { acc.best = Veye; acc.bestDir = [dE, dN, sinAlt]; }
      if (draw) draw.push(dE, dN, sinAlt, pieceMag(albedo, ds * 1e3, w, d, phi, X), w / (d * 1e3));
    }
  }

  /**
   * One ring at one instant.
   *
   * opts: { lat, lst, dec, art (Bortle skyglow or null), dNode (degrees to
   *         turn the ring about the pole, from nodeOffset; 0 if omitted),
   *         local (bool: also return the visible samples for drawing) }
   *
   * Arc lengths are angles on the sky, in degrees, summed over samples:
   *   up       ring above the horizon
   *   lit      of that, in sunlight
   *   visible  of that, bright enough to see against the local sky
   * best is the brightest one-arcminute patch that is visible (magnitude),
   * with its direction in east/north/up for aiming. draw, if local, packs
   * [east, north, up, V, width] per visible sample, where V is for the
   * sample's own length so the drawn line carries the right total light,
   * and width is the ring's angular width there in radians (width / range,
   * face-on), so wide nearby rings can be drawn as bands.
   *
   * cable holds the same arcs and best for all elevator cables together,
   * and its visible samples go into draw too. stations counts stations
   * above the horizon, lit, and visible (each a point source of area
   * stSize^2 against the local sky), with stationBest the brightest visible
   * one's magnitude, and stationDraw packing [east, north, up, V] for each
   * visible station.
   */
  function evaluate(ring, opts) {
    var sc = scene(opts), sp = ring.spec, local = !!opts.local;
    var draw = local ? [] : null;
    var acc = { up: 0, lit: 0, visible: 0, best: null, bestDir: null };
    scanLine(sc, ring.pos, ring.tan, ring.n, ring.ds, sp.width, sp.albedo, acc, draw);
    var cab = { up: 0, lit: 0, visible: 0, best: null, bestDir: null };
    var C = ring.cable;
    if (C && C.n) scanLine(sc, C.pos, C.tan, C.n, C.ds, sp.cable, sp.albedo, cab, draw);

    var o = sc.o, s = sc.s, st = { total: ring.nStations || 0, up: 0, lit: 0, visible: 0 };
    var stBest = null, stDraw = local ? [] : null;
    for (var q = 0; q < st.total; q++) {
      var px = ring.stations[3 * q], py = ring.stations[3 * q + 1], pz = ring.stations[3 * q + 2];
      var rx = px - o.r[0], ry = py - o.r[1], rz = pz - o.r[2];
      var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
      var vx = rx / d, vy = ry / d, vz = rz / d;
      var sinAlt = vx * o.up[0] + vy * o.up[1] + vz * o.up[2];
      if (!(sinAlt > 0)) continue;
      st.up++;
      if (!isLit(px, py, pz, s)) continue;
      st.lit++;
      var alt = Math.asin(clip(sinAlt, -1, 1));
      var cosphi = clip(-(vx * s[0] + vy * s[1] + vz * s[2]), -1, 1);
      var V = pieceMag(sp.albedo, sp.stSize, sp.stSize, d, Math.acos(cosphi), ODC.airmassLSM(alt));
      if (!(V < ODC.limitingMag(ODC.skyAt(alt, Math.acos(-cosphi) / DEG, sc.ctx)))) continue;
      st.visible++;
      if (stBest === null || V < stBest) stBest = V;
      if (local) {
        stDraw.push(vx * o.east[0] + vy * o.east[1] + vz * o.east[2],
                    vx * o.north[0] + vy * o.north[1] + vz * o.north[2], sinAlt, V);
      }
    }
    return {
      sunEl: sc.sunEl, up: acc.up, lit: acc.lit, visible: acc.visible, best: acc.best,
      bestDir: acc.bestDir, cable: cab, stations: st, stationBest: stBest,
      draw: local ? new Float32Array(draw) : null,
      stationDraw: local ? new Float32Array(stDraw) : null
    };
  }

  /**
   * Where the ring is, visible or not, so the caller can draw guide lines
   * and show which parts Earth's shadow covers. Use a coarse ring.
   *   ring      [east, north, up, lit] per ring sample, in ring order
   *   cables    the same, one array per cable, from the ground up
   *   stations  [east, north, up, lit] per station
   * Samples below the horizon are NaN, which breaks the line.
   */
  function path(ring, lat, lst, dec, dNode) {
    var f = frame(lat, lst, dec, dNode), o = f.o, s = f.s;
    function walk(P, from, to, out) {
      for (var k = from; k < to; k++) {
        var px = P[3 * k], py = P[3 * k + 1], pz = P[3 * k + 2];
        var rx = px - o.r[0], ry = py - o.r[1], rz = pz - o.r[2];
        var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
        var dU = (rx * o.up[0] + ry * o.up[1] + rz * o.up[2]) / d;
        if (!(dU > 0)) { out.push(NaN, NaN, NaN, 0); continue; }
        out.push((rx * o.east[0] + ry * o.east[1] + rz * o.east[2]) / d,
                 (rx * o.north[0] + ry * o.north[1] + rz * o.north[2]) / d, dU,
                 isLit(px, py, pz, s) ? 1 : 0);
      }
      return out;
    }
    var C = ring.cable, cables = [];
    for (var q = 0; C && C.perCable && q < ring.nStations; q++) {
      cables.push(walk(C.pos, q * C.perCable, (q + 1) * C.perCable, []));
    }
    return {
      ring: walk(ring.pos, 0, ring.n, []),
      cables: cables,
      stations: walk(ring.stations, 0, ring.nStations || 0, [])
    };
  }

  /**
   * Highest latitude from which an EQUATORIAL ring of this altitude rises
   * above the horizon at all, degrees: cos(lat) = R_E / (R_E + alt).
   */
  function equatorialMaxLat(altKm) {
    return Math.acos(R_E / (R_E + altKm)) / DEG;
  }

  var api = {
    LIMITS: LIMITS, DEFAULTS: DEFAULTS, EYE: EYE, sanitize: sanitize, build: build,
    evaluate: evaluate, pieceMag: pieceMag, path: path, equatorialMaxLat: equatorialMaxLat,
    nodeRate: nodeRate, nodeShift: nodeShift, nodeOffset: nodeOffset, dayNumber: dayNumber
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RINGS = api;
})(typeof window !== "undefined" ? window : this);

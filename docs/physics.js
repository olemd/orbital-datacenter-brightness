/*
 * Physics for the browser version. A line-by-line port of the Python in this
 * repository, not a reimplementation:
 *
 *   lsm.py        orbits, eclipse, both brightness models
 *   solar.py      solar declination, right ascension, sunset
 *   twilight.py   zenith sky brightness and naked-eye limiting magnitude
 *   skymodel.py   sky brightness across the dome
 *   realstars.py  the HYG star catalog
 *
 * JavaScript arithmetic is double precision, the same as numpy, and the
 * constellation is loaded from the exact layout lsm.build_sso produces
 * (export_web_data.py), so the counts here are the counts in the README.
 * validate_web.py checks that.
 *
 * Works in a browser (window.ODC) and in Node (require) so it can be tested
 * against the Python directly.
 */
(function (root) {
  "use strict";

  var DEG = Math.PI / 180;
  var R_E = 6378.137;               // km, equatorial, as Boley et al. use
  var MU = 398600.4418;
  var K_EXT = 0.15;                 // mag per airmass
  var V_SUN = -26.77;
  var ZETA = 0.2 * 800.0;           // m^2, albedo x cross-section
  var BOLEY_K = 2.0 * ZETA / (3.0 * Math.PI * Math.PI);
  var MINI_PHASE = [2.630, 0.1065, -0.0005167];   // Mallama et al. 2023, Fig 5
  var AI1_DELTA_MAG = 2.5 * Math.log10(710.0 / 116.03);
  var NELM_MAX = 7.93;              // limiting_mag as the sky goes to black
  var ALT_MIN_COUNT = -0.005;       // rad, the whole-sky counting convention
  var SIN_ALT_MIN = Math.sin(ALT_MIN_COUNT);

  // twilight.BORTLE: artificial skyglow at the zenith, mag/arcsec2
  var BORTLE = { 1: null, 2: 22.0, 3: 21.5, 4: 20.8, 5: 19.8, 6: 18.8, 7: 18.2, 8: 17.5 };

  // skymodel.py shape parameters
  var A_SUN = 3.0, THETA0 = 28.0, H_AIRGLOW = 90.0;
  var BELT_MAG = 0.55, SHADOW_MAG = 0.85;

  function mod(x, n) { return ((x % n) + n) % n; }
  function clip(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  // Python 3 round(): half to even. Matters for plane subsampling, where
  // per_plane * fraction can land exactly on .5.
  function pyRound(x) {
    var f = Math.floor(x), r = x - f;
    if (r > 0.5) return f + 1;
    if (r < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }

  // ------------------------------------------------------------- solar.py
  function daysSinceJ2000(year, month, day) {
    var a = Math.floor((14 - month) / 12);
    var y = year + 4800 - a;
    var m = month + 12 * a - 3;
    var jdn = day + Math.floor((153 * m + 2) / 5) + 365 * y + Math.floor(y / 4)
      - Math.floor(y / 100) + Math.floor(y / 400) - 32045;
    return jdn - 2451545.0 + 0.5;
  }

  /** Solar declination (deg) and right ascension (hours) for a date. */
  function sun(year, month, day) {
    var d = daysSinceJ2000(year, month, day);
    var Lm = mod(280.460 + 0.9856474 * d, 360.0);
    var g = mod(357.528 + 0.9856003 * d, 360.0) * DEG;
    var lam = (Lm + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
    var e = 23.439 * DEG;
    var dec = Math.asin(Math.sin(e) * Math.sin(lam)) / DEG;
    var ra = mod(Math.atan2(Math.cos(e) * Math.sin(lam), Math.cos(lam)) / DEG, 360.0);
    return { dec: dec, ra: ra / 15.0 };
  }

  /**
   * Local solar time of sunset, hours, or a reason there is none.
   * { lst: 18.2 } or { lst: null, kind: "polar_night" | "midnight_sun" }
   */
  function sunset(latDeg, decDeg) {
    var x = -Math.tan(latDeg * DEG) * Math.tan(decDeg * DEG);
    if (x < -1) return { lst: null, kind: "midnight_sun" };
    if (x > 1) return { lst: null, kind: "polar_night" };
    return { lst: 12.0 + Math.acos(x) / DEG / 15.0, kind: "normal" };
  }

  // --------------------------------------------------------------- lsm.py
  function cross(a, b) {
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  }
  function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }

  /** Observer position (km) and local east/north/up, for local solar time. */
  function observer(latDeg, lstHr) {
    var lon = (lstHr - 12.0) * 15.0 * DEG;
    var lat = latDeg * DEG;
    var up = [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
    var east = cross([0, 0, 1], up);
    var en = Math.sqrt(dot(east, east));
    east = [east[0] / en, east[1] / en, east[2] / en];
    var north = cross(up, east);
    return { r: [R_E * up[0], R_E * up[1], R_E * up[2]], up: up, east: east, north: north };
  }

  function sunDir(decDeg) {
    var d = decDeg * DEG;
    return [Math.cos(d), 0.0, Math.sin(d)];
  }

  /** Solar elevation (deg) and azimuth (rad, from north through east). */
  function sunAltAz(latDeg, lstHr, decDeg) {
    var o = observer(latDeg, lstHr), s = sunDir(decDeg);
    return {
      el: Math.asin(clip(dot(s, o.up), -1, 1)) / DEG,
      az: mod(Math.atan2(dot(s, o.east), dot(s, o.north)), 2 * Math.PI)
    };
  }

  /** lsm.airmass: Kasten & Young 1989, as used in Boley et al. */
  function airmassLSM(altRad) {
    var z = clip(90.0 - altRad / DEG, 0.0, 91.5);
    return 1.0 / (Math.cos(z * DEG) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
  }

  // ---------------------------------------------------------- twilight.py
  function skyBrightness(sunElDeg) {
    var x = Math.max(sunElDeg, -18.0);
    var out = (x > -12.0) ? (-1.057 * x + 6.7489)
                          : (-0.0744 * x * x - 2.5768 * x - 0.5845);
    return Math.min(out, 21.75);
  }
  function limitingMag(sqm) {
    return 7.93 - 5.0 * Math.log10(1.0 + Math.pow(10.0, 4.316 - sqm / 5.0));
  }
  function addGlow(sqmNatural, sqmArt) {
    if (sqmArt === null || sqmArt === undefined) return sqmNatural;
    return -2.5 * Math.log10(Math.pow(10, -0.4 * sqmNatural) + Math.pow(10, -0.4 * sqmArt));
  }
  function nelm(sunElDeg, sqmArt) {
    return limitingMag(addGlow(skyBrightness(sunElDeg), sqmArt));
  }

  // ---------------------------------------------------------- skymodel.py
  function airmassSK(altRad) {
    var z = clip(90.0 - Math.max(altRad / DEG, 2.0), 0.0, 88.0);
    return 1.0 / (Math.cos(z * DEG) + 0.50572 * Math.pow(96.07995 - z, -1.6364));
  }
  var RE_GLOW = 6371.0;
  var GLOW_Q = Math.pow(RE_GLOW / (RE_GLOW + H_AIRGLOW), 2);
  function airglow(altRad) {
    var z = Math.PI / 2 - Math.max(altRad, 0.5 * DEG);
    var sz = Math.sin(z);
    var q = GLOW_Q * sz * sz;
    var vanRhijn = 1.0 / Math.sqrt(Math.max(1.0 - q, 1e-6));
    var X = airmassSK(altRad);
    var ratio = vanRhijn * Math.pow(10.0, -0.4 * 0.15 * (X - 1.0));
    return -2.5 * Math.log10(Math.max(ratio, 1e-6));
  }
  function shadowHeight(sunElDeg) { return clip(-2.1 * sunElDeg, 0.0, 90.0); }

  /**
   * Sky brightness, mag/arcsec2, at one point on the dome.
   * altRad: elevation; thetaDeg: angular distance from the Sun.
   * ctx: { S0, twi, h, art } precomputed once per instant by skyContext.
   */
  function skyAt(altRad, thetaDeg, ctx) {
    var ag = airglow(altRad);
    var S = ctx.S0 - A_SUN * ctx.twi * Math.exp(-thetaDeg / THETA0) + ag;
    var anti = clip((thetaDeg - 90.0) / 60.0, 0.0, 1.0);
    if (anti > 0 && ctx.twi > 0) {
      var e = altRad / DEG;
      var inside = clip((ctx.h - e) / 4.0, 0.0, 1.0);
      var u = (e - ctx.h - 4.0) / 5.0;
      var belt = Math.exp(-u * u);
      S += ctx.twi * anti * (SHADOW_MAG * inside - BELT_MAG * belt);
    }
    if (ctx.art !== null) S = addGlow(S, ctx.art + ag);
    return S;
  }
  function skyContext(sunElDeg, sqmArt) {
    return {
      S0: skyBrightness(sunElDeg),
      twi: clip((sunElDeg + 18.0) / 18.0, 0.0, 1.0),
      h: shadowHeight(sunElDeg),
      art: (sqmArt === undefined) ? null : sqmArt,
      sunEl: sunElDeg
    };
  }

  // ------------------------------------------------------ data and layout
  function decodeBase64(b64) {
    if (typeof Buffer !== "undefined" && typeof window === "undefined") {
      var b = Buffer.from(b64, "base64");
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    }
    var bin = atob(b64), n = bin.length, u = new Uint8Array(n);
    for (var i = 0; i < n; i++) u[i] = bin.charCodeAt(i);
    return u.buffer;
  }

  /** Build one constellation variant from the exported layout. */
  function loadConstellation(manifest, buf, spreadKey) {
    var v = manifest.variants[spreadKey];
    var LSB = manifest.lsb, groups = [], total = 0;
    for (var gi = 0; gi < v.groups.length; gi++) {
      var G = v.groups[gi], np = G.n_planes, per = G.per;
      var planes = new Float64Array(buf, G.planes_offset, np * 9);
      var jit = new Int16Array(buf, G.jitter_offset, np * per);
      var c0 = new Float64Array(np * per), s0 = new Float64Array(np * per);
      for (var p = 0; p < np; p++) {
        var off = planes[p * 9 + 8];
        for (var k = 0; k < per; k++) {
          var th = 2 * Math.PI * k / per + off + jit[p * per + k] * LSB;
          c0[p * per + k] = Math.cos(th);
          s0[p * per + k] = Math.sin(th);
        }
      }
      groups.push({ nPlanes: np, per: per, planes: planes, c0: c0, s0: s0 });
      total += np * per;
    }
    return { spread: Number(spreadKey), groups: groups, total: total };
  }

  /** sky_view.subsample: first `used` satellites of each plane, and the scale. */
  function subsample(cons, nWant) {
    var nFull = 500000, used = [], tot = 0;
    if (nWant >= nFull) {
      for (var i = 0; i < cons.groups.length; i++) used.push(cons.groups[i].per);
      return { used: used, scale: nFull / cons.total };
    }
    var frac = Math.max(nWant / nFull, 1e-6);
    for (var j = 0; j < cons.groups.length; j++) {
      var g = cons.groups[j], u = Math.max(pyRound(g.per * frac), 1);
      used.push(u);
      tot += g.nPlanes * u;
    }
    return { used: used, scale: nWant / Math.max(tot, 1) };
  }

  function loadStars(manifest, buf) {
    var n = manifest.stars.n;
    var a = new Float32Array(buf, manifest.stars.offset, n * 4);
    var ra = new Float64Array(n), dec = new Float64Array(n);
    var mag = new Float64Array(n), rgb = new Float32Array(n * 3);
    for (var i = 0; i < n; i++) {
      ra[i] = a[i * 4]; dec[i] = a[i * 4 + 1]; mag[i] = a[i * 4 + 2];
      var t = clip((a[i * 4 + 3] + 0.4) / 2.0, 0.0, 1.0);
      rgb[i * 3] = 0.72 * (1 - t) + 1.00 * t;
      rgb[i * 3 + 1] = 0.80 * (1 - t) + 0.78 * t;
      rgb[i * 3 + 2] = 1.00 * (1 - t) + 0.60 * t;
    }
    return { n: n, ra: ra, dec: dec, mag: mag, rgb: rgb };
  }

  // ------------------------------------------------- one instant, one sky
  function Growable(n) { this.a = new Float32Array(n); this.n = 0; }
  Growable.prototype.push4 = function (x, y, z, w) {
    if (this.n + 4 > this.a.length) {
      var b = new Float32Array(this.a.length * 2); b.set(this.a); this.a = b;
    }
    var a = this.a, n = this.n;
    a[n] = x; a[n + 1] = y; a[n + 2] = z; a[n + 3] = w; this.n = n + 4;
  };

  var NBINS = 180;

  /**
   * Everything about the constellation at one instant.
   *
   * opts: { lat, lst, dec, t (s of orbital motion), art (Bortle skyglow or
   *         null), sub (from subsample), local (bool: also build the drawn
   *         lists, which need the sky brightness at each satellite) }
   *
   * Returns whole-sky counts for both models against the zenith limit, which
   * is the convention every table in the repository uses, and, if local, the
   * satellites that beat the sky at their own position: ENU direction and V,
   * packed as [x, y, z, V] per satellite. Same test as frame.render, so what
   * is drawn is what is counted in view.
   */
  function evaluate(cons, opts) {
    var o = observer(opts.lat, opts.lst), s = sunDir(opts.dec);
    var ox = o.r[0], oy = o.r[1], oz = o.r[2];
    var ux = o.up[0], uy = o.up[1], uz = o.up[2];
    var ex = o.east[0], ey = o.east[1], ez = o.east[2];
    var nx = o.north[0], ny = o.north[1], nz = o.north[2];
    var sx = s[0], sy = s[1], sz = s[2];
    var sunEl = Math.asin(clip(sx * ux + sy * uy + sz * uz, -1, 1)) / DEG;
    var art = (opts.art === undefined) ? null : opts.art;
    var vl = limitingMag(addGlow(skyBrightness(sunEl), art));
    var ctx = skyContext(sunEl, art);
    var t = opts.t || 0, local = !!opts.local;
    var sub = opts.sub || subsample(cons, 500000);
    var RE2 = R_E * R_E;

    var nB = 0, nM = 0;
    var histB = new Float64Array(NBINS), histM = new Float64Array(NBINS);
    var drawB = local ? new Growable(1 << 17) : null;
    var drawM = local ? new Growable(1 << 15) : null;
    var c0M = MINI_PHASE[0], c1M = MINI_PHASE[1], c2M = MINI_PHASE[2];

    for (var gi = 0; gi < cons.groups.length; gi++) {
      var G = cons.groups[gi], P = G.planes, per = G.per, used = sub.used[gi];
      var C0 = G.c0, S0 = G.s0;
      for (var p = 0; p < G.nPlanes; p++) {
        var b = p * 9, a = P[b + 6], nn = P[b + 7];
        var Ax = a * P[b], Ay = a * P[b + 1], Az = a * P[b + 2];
        var Bx = a * P[b + 3], By = a * P[b + 4], Bz = a * P[b + 5];
        var ct = 1, st = 0;
        if (t !== 0) { ct = Math.cos(nn * t); st = Math.sin(nn * t); }
        var base = p * per;
        for (var k = 0; k < used; k++) {
          var cc = C0[base + k], ss = S0[base + k], c, sn;
          if (t !== 0) { c = cc * ct - ss * st; sn = ss * ct + cc * st; }
          else { c = cc; sn = ss; }
          // lsm.propagate: (cos th node + sin th m) a
          var px = c * Ax + sn * Bx, py = c * Ay + sn * By, pz = c * Az + sn * Bz;
          var rx = px - ox, ry = py - oy, rz = pz - oz;
          var dUp = rx * ux + ry * uy + rz * uz;
          if (dUp < -120.0) continue;          // far below the horizon
          var d = Math.sqrt(rx * rx + ry * ry + rz * rz);
          // same operation order as numpy: normalise, then dot
          var vx = rx / d, vy = ry / d, vz = rz / d;
          var sinAlt = vx * ux + vy * uy + vz * uz;
          if (!(sinAlt > SIN_ALT_MIN)) continue;
          // lsm.sunlit: cylindrical umbra
          var along = px * sx + py * sy + pz * sz;
          if (!(along > 0)) {
            var qx = px - along * sx, qy = py - along * sy, qz = pz - along * sz;
            if (!(Math.sqrt(qx * qx + qy * qy + qz * qz) > R_E)) continue;
          }
          var alt = Math.asin(clip(sinAlt, -1, 1));
          if (!(alt > ALT_MIN_COUNT)) continue;
          var cosphi = clip(-(vx * sx + vy * sy + vz * sz), -1.0, 1.0);
          var phi = Math.acos(cosphi);
          var X = airmassLSM(alt);
          // Boley, Lawler & Rein eq 2
          var gph = (Math.PI - phi) * Math.cos(phi) + Math.sin(phi);
          var VB = V_SUN - 2.5 * Math.log10(Math.max(BOLEY_K * gph, 1e-300))
            + 5.0 * Math.log10(d * 1e3) + K_EXT * X;
          // Mallama Gen2 Mini, scaled to AI1
          var pd = phi / DEG;
          var VM = c0M + c1M * pd + c2M * pd * pd - AI1_DELTA_MAG
            + 5.0 * Math.log10(d / 1000.0) + K_EXT * X;

          var inB = VB < vl, inM = VM < vl, bin = -1;
          if (inB || inM) {
            nB += inB ? 1 : 0; nM += inM ? 1 : 0;
            if (alt > 0) {
              var az = mod(Math.atan2(vx * ex + vy * ey + vz * ez, vx * nx + vy * ny + vz * nz),
                           2 * Math.PI);
              bin = Math.min(Math.floor(az / (2 * Math.PI) * NBINS), NBINS - 1);
              if (inB) histB[bin] += 1;
              if (inM) histM[bin] += 1;
            }
          }
          if (local && alt > 0 && (VB < NELM_MAX || VM < NELM_MAX)) {
            // angle from the Sun: cos theta = u . s = -cos phi
            var theta = Math.acos(-cosphi) / DEG;
            var lim = limitingMag(skyAt(alt, theta, ctx));
            if (VB < lim || VM < lim) {
              var dE = vx * ex + vy * ey + vz * ez;
              var dN = vx * nx + vy * ny + vz * nz;
              if (VB < lim) drawB.push4(dE, dN, sinAlt, VB);
              if (VM < lim) drawM.push4(dE, dN, sinAlt, VM);
            }
          }
        }
      }
    }
    return {
      sunEl: sunEl, vlim: vl, scale: sub.scale,
      count: { boley: nB * sub.scale, mini: nM * sub.scale },
      hist: { boley: histB, mini: histM },
      draw: local ? { boley: drawB, mini: drawM } : null
    };
  }

  /**
   * Stars at one instant. Whole-sky count against the zenith limit, as in
   * sky_view.star_counts_zenith, and the drawn list against the local sky, as
   * in pano.visible_altaz: [x, y, z, V_observed] plus an RGB array.
   */
  function evaluateStars(stars, opts) {
    var lstStar = mod(opts.raSun + opts.lst - 12.0, 24.0);
    var lat = opts.lat * DEG, sl = Math.sin(lat), cl = Math.cos(lat);
    var sa = sunAltAz(opts.lat, opts.lst, opts.dec);
    var art = (opts.art === undefined) ? null : opts.art;
    var zen = limitingMag(addGlow(skyBrightness(sa.el), art));
    var ctx = skyContext(sa.el, art);
    var sEl = sa.el * DEG;
    var sE = Math.cos(sEl) * Math.sin(sa.az), sN = Math.cos(sEl) * Math.cos(sa.az), sU = Math.sin(sEl);
    var countOnly = !!opts.countOnly;
    var n = 0, draw = countOnly ? null : new Growable(4 * 4096), rgb = [];
    for (var i = 0; i < stars.n; i++) {
      var ha = (lstStar - stars.ra[i]) * 15.0 * DEG;
      var d = stars.dec[i] * DEG, sd = Math.sin(d), cd = Math.cos(d), ch = Math.cos(ha);
      var sinAlt = sd * sl + cd * cl * ch;
      var alt = Math.asin(clip(sinAlt, -1, 1));
      if (!(alt > 0)) continue;
      var azN = sd * cl - cd * sl * ch, azE = -cd * Math.sin(ha);
      var m = stars.mag[i] + K_EXT * airmassLSM(alt);
      if (m < zen) n++;
      if (countOnly) continue;
      var ca = Math.cos(alt), az = Math.atan2(azE, azN);
      var dE = ca * Math.sin(az), dN = ca * Math.cos(az), dU = Math.sin(alt);
      var theta = Math.acos(clip(dE * sE + dN * sN + dU * sU, -1, 1)) / DEG;
      if (m < limitingMag(skyAt(alt, theta, ctx))) {
        draw.push4(dE, dN, dU, m);
        rgb.push(stars.rgb[i * 3], stars.rgb[i * 3 + 1], stars.rgb[i * 3 + 2]);
      }
    }
    return { count: n, draw: draw, rgb: new Float32Array(rgb) };
  }

  /**
   * sky_view.ring_azimuth: the centre of the fullest window of width hfov,
   * sliding around the horizon. Not the mean azimuth, which for a two-lobed
   * ring lands in the gap.
   */
  function ringAzimuth(hist, hfovDeg) {
    var nb = NBINS, sum = 0;
    for (var i = 0; i < nb; i++) sum += hist[i];
    if (sum < 1) return null;
    var w = Math.max(pyRound(hfovDeg / (360.0 / nb)), 1);
    var lead = Math.floor((w - 1) / 2), best = -1, bestI = 0;
    for (var k = 0; k < nb; k++) {
      // numpy convolve 'same' over the tiled histogram, index k + nb
      var acc = 0, hiIdx = k + nb + lead;
      for (var j = hiIdx - w + 1; j <= hiIdx; j++) acc += hist[mod(j, nb)];
      if (acc > best) { best = acc; bestI = k; }
    }
    return (bestI + 0.5) * (360.0 / nb);
  }

  var api = {
    DEG: DEG, R_E: R_E, BORTLE: BORTLE, K_EXT: K_EXT,
    sun: sun, sunset: sunset, observer: observer, sunDir: sunDir, sunAltAz: sunAltAz,
    airmassLSM: airmassLSM, skyBrightness: skyBrightness, limitingMag: limitingMag,
    addGlow: addGlow, nelm: nelm, airglow: airglow, skyContext: skyContext, skyAt: skyAt,
    decodeBase64: decodeBase64, loadConstellation: loadConstellation,
    loadStars: loadStars, subsample: subsample, evaluate: evaluate,
    evaluateStars: evaluateStars, ringAzimuth: ringAzimuth, pyRound: pyRound,
    SKY: { A_SUN: A_SUN, THETA0: THETA0, BELT_MAG: BELT_MAG, SHADOW_MAG: SHADOW_MAG,
           GLOW_Q: GLOW_Q }
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.ODC = api;
})(typeof window !== "undefined" ? window : this);

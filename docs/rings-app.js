/*
 * The front end for rings.html: controls, the WebGL sky, the night curve and
 * the numbers. Ring physics lives in rings.js, everything else (Sun, sky,
 * stars) in physics.js.
 *
 * The sky and star rendering is the satellite page's (app.js), kept the same
 * on purpose so the two pages look alike and the rings sit in the same
 * modelled sky: linear flux relative to a dark sky, Gaussian point sources,
 * partial eye adaptation and a Reinhard curve. A ring is drawn as a dense
 * line of samples, each carrying the light of its own piece of ring, so the
 * total brightness of the line is right however finely it is sampled.
 */
(function () {
  "use strict";

  var VERSION = "2026-10-02";
  var P = window.ODC, RG = window.RINGS;
  var DEG = Math.PI / 180;
  var POINTS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  var BORTLE_NAMES = { 1: "1, pristine dark site", 2: "2, dark site", 3: "3, rural",
    4: "4, rural to suburban", 5: "5, suburban", 6: "6, bright suburban",
    7: "7, suburban to urban", 8: "8, city" };
  var PIX_REF = Math.pow(95.0 * 3600.0 / 1672.0, 2);
  var SIGMA_RING = 1.0, SIGMA_STAR = 1.15;
  var MAX_RINGS = 6;
  // Ring identity is carried by number and dash pattern as well as colour,
  // so the curve and table read without colour vision.
  var RING_COLORS = ["#ff9a3c", "#7ab8ff", "#7fd99a", "#f28bd0", "#e8d36a", "#b9a4ff"];
  var RING_DASH = ["", "7 3", "2 3", "9 3 2 3", "4 4", "1 2"];
  // Editor fields. mode says which kind of ring shows the field: "sky" for
  // star-fixed, "ground" for ground-fixed (Birch), or both if omitted.
  var FIELDS = [
    { k: "alt", label: "Altitude", unit: "km", step: 50 },
    { k: "inc", label: "Inclination", unit: "°", step: 1 },
    { k: "raan", label: "Node RA", unit: "°", step: 5, mode: "sky",
      title: "Right ascension of the ascending node: where the ring crosses the celestial " +
        "equator going north. Has no effect on an equatorial ring." },
    { k: "lon", label: "Node, east of you", unit: "° longitude", step: 5, mode: "ground",
      title: "Where the ring crosses the equator going north, as degrees of longitude east of " +
        "you (negative for west). The first station sits there. Has no effect on an " +
        "equatorial ring except to place the stations." },
    { k: "width", label: "Width", unit: "m", step: 10 },
    { k: "albedo", label: "Albedo", unit: "", step: 0.05 },
    { k: "stations", label: "Stations", unit: "", step: 1, mode: "ground",
      title: "Stations spaced evenly around the ring, starting at the node. 0 for none." },
    { k: "stSize", label: "Station size", unit: "m", step: 50, mode: "ground",
      title: "Each station reflects like a diffuse surface this many metres square." },
    { k: "cable", label: "Elevator cable", unit: "m thick", step: 1, mode: "ground",
      title: "Thickness of the elevator cable hanging from each station to the ground. 0 for none." }
  ];
  function ring(alt, inc, raan) { return { alt: alt, inc: inc, raan: raan || 0, width: 100, albedo: 0.2 }; }
  function birch(alt, inc, lon, stations) {
    return { alt: alt, inc: inc, raan: 0, width: 100, albedo: 0.2, fix: 1, lon: lon,
             stations: stations, stSize: 500, cable: 5 };
  }
  var PRESETS = {
    mixed: { name: "Two equatorial and one tilted", rings: [ring(1000, 0), ring(3000, 0), ring(2000, 45, 0)] },
    one: { name: "One equatorial ring, 2,000 km", rings: [ring(2000, 0)] },
    stack: { name: "Equatorial stack: 500 to 20,000 km",
             rings: [ring(500, 0), ring(2000, 0), ring(5000, 0), ring(20000, 0)] },
    polar: { name: "Equatorial and polar", rings: [ring(2000, 0), ring(2000, 90, 0)] },
    tilted: { name: "Crossed pair at 30°", rings: [ring(3000, 30, 0), ring(3000, 30, 180)] },
    birch: { name: "Birch network: ground-fixed, with stations",
             rings: [birch(1000, 0, 20, 8), birch(1000, 60, 20, 6), birch(1000, 90, -15, 6)] }
  };

  function $(id) { return document.getElementById(id); }
  function fmt(x) { return Math.round(x).toLocaleString("en-US"); }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function mod(x, n) { return ((x % n) + n) % n; }
  function pointName(azDeg) { return POINTS16[Math.round(mod(azDeg, 360) / 22.5) % 16]; }
  function sunTime(lst) {
    var h = mod(lst, 24), hh = Math.floor(h), mm = Math.round((h - hh) * 60);
    if (mm === 60) { hh = (hh + 1) % 24; mm = 0; }
    var ap = hh < 12 ? "am" : "pm", h12 = hh % 12 === 0 ? 12 : hh % 12;
    return h12 + ":" + (mm < 10 ? "0" : "") + mm + " " + ap;
  }
  function todayISO() {
    var d = new Date(), m = d.getMonth() + 1, dd = d.getDate();
    return d.getFullYear() + "-" + (m < 10 ? "0" : "") + m + "-" + (dd < 10 ? "0" : "") + dd;
  }
  function fatal(msg) { var f = $("fatal"); f.textContent = msg; f.hidden = false; }
  function ringName(sp) {
    return fmt(sp.alt) + " km, " + (sp.inc === 0 ? "equatorial" : Math.round(sp.inc) + "° tilt") +
      (sp.fix ? ", ground-fixed" : "");
  }

  // ------------------------------------------------------------- state
  // epoch: the date the typed node RAs refer to; prec: apply J2 node drift
  var S = { lat: 37.2, date: todayISO(), t: 120, bortle: 1, az: 180, el: 25, fov: 100,
            grid: false, paths: true, rings: PRESETS.mixed.rings.map(RG.sanitize),
            epoch: "2026-03-20", prec: true };
  var autoAim = true, elFromHash = false;

  (function readHash() {
    var h = location.hash.replace(/^#/, "");
    if (!h) return;
    var q = {};
    h.split("&").forEach(function (kv) { var p = kv.split("="); q[p[0]] = decodeURIComponent(p[1] || ""); });
    function num(k, lo, hi) { var v = parseFloat(q[k]); return isFinite(v) ? clamp(v, lo, hi) : null; }
    var v;
    if ((v = num("lat", -89, 89)) !== null) S.lat = Math.round(v * 10) / 10;
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.date || "")) S.date = q.date;
    if ((v = num("t", -1440, 1440)) !== null) S.t = v;
    if ((v = num("b", 1, 8)) !== null) S.bortle = Math.round(v);
    if ((v = num("fov", 20, 120)) !== null) S.fov = v;
    if ((v = num("el", -10, 89.5)) !== null) { S.el = v; elFromHash = true; }
    if ((v = num("az", 0, 360)) !== null) { S.az = v; autoAim = false; }
    if (/^\d{4}-\d{2}-\d{2}$/.test(q.ep || "")) S.epoch = q.ep;
    if (q.pr === "0" || q.pr === "1") S.prec = q.pr === "1";
    // r=alt,inc,raan,width,albedo[,fix,lon,stations,stSize,cable];...
    // every value clamped by RG.sanitize; missing trailing fields (older
    // links) take RG.DEFAULTS
    if (q.r) {
      var rs = q.r.split(";").slice(0, MAX_RINGS).map(function (t) {
        var f = t.split(",").map(Number);
        return RG.sanitize({ alt: f[0], inc: f[1], raan: f[2], width: f[3], albedo: f[4],
                             fix: f[5], lon: f[6], stations: f[7], stSize: f[8], cable: f[9] });
      });
      if (rs.length) S.rings = rs;
    }
  })();

  var hashTimer = null;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(function () {
      var r = S.rings.map(function (sp) {
        return [sp.alt, sp.inc, sp.raan, sp.width, sp.albedo,
                sp.fix, sp.lon, sp.stations, sp.stSize, sp.cable].join(",");
      }).join(";");
      var s = "lat=" + S.lat + "&date=" + S.date + "&t=" + Math.round(S.t) + "&b=" + S.bortle +
        "&r=" + r + "&ep=" + S.epoch + "&pr=" + (S.prec ? 1 : 0) + "&az=" + Math.round(S.az) + "&el=" + Math.round(S.el) + "&fov=" + Math.round(S.fov);
      history.replaceState(null, "", "#" + s);
    }, 300);
  }

  // -------------------------------------------------------------- data
  // stars.js (export_ring_stars.py): the star catalog without the satellites
  var man = window.ODC_STARS_MANIFEST;
  if (!man || !window.ODC_STARS_BLOB || !P || !RG) { fatal("The data file did not load."); return; }
  var stars = P.loadStars(man, P.decodeBase64(window.ODC_STARS_BLOB));

  // Built rings depend on the spec and, through the node, on the date.
  var built = { key: "", fine: [], coarse: [] };
  function rings() {
    var key = JSON.stringify(S.rings) + "|" + N.ra;
    if (key !== built.key) {
      built = {
        key: key,
        fine: S.rings.map(function (sp) { return RG.build(sp, N.ra, false); }),
        coarse: S.rings.map(function (sp) { return RG.build(sp, N.ra, true); })
      };
    }
    return built;
  }

  var N = null;
  function computeNight() {
    var ymd = S.date.split("-").map(Number);
    var sun = P.sun(ymd[0], ymd[1], ymd[2]);
    var ss = P.sunset(S.lat, sun.dec);
    var n = { dec: sun.dec, ra: sun.ra, kind: ss.kind };
    if (ss.kind === "normal") {
      n.ref = ss.lst;
      n.len = (48 - 2 * ss.lst) * 60;
      n.lo = -20; n.hi = Math.round(n.len + 20);
    } else {
      n.ref = 12.0; n.len = 1440; n.lo = 0; n.hi = 1440;
    }
    return n;
  }
  function lstNow() { return N.ref + S.t / 60.0; }

  // Rotation of ring i about the pole at local solar time lst: J2 drift for
  // a star-fixed ring, turning with the Earth for a ground-fixed one.
  function dNode(i, lst) {
    return RG.nodeOffset(S.rings[i], S.date, lst, S.epoch, S.prec);
  }

  // ------------------------------------------------------ the instant
  var R = null;
  function evaluateNow() {
    var art = P.BORTLE[S.bortle], lst = lstNow(), B = rings();
    var res = B.fine.map(function (r, i) {
      return RG.evaluate(r, { lat: S.lat, lst: lst, dec: N.dec, art: art, local: true, dNode: dNode(i, lst) });
    });
    var paths = S.paths ? B.coarse.map(function (r, i) {
      return RG.path(r, S.lat, lst, N.dec, dNode(i, lst));
    }) : null;
    var st = P.evaluateStars(stars, { lat: S.lat, lst: lst, dec: N.dec, raSun: N.ra, art: art });
    var sa = P.sunAltAz(S.lat, lst, N.dec);
    R = { rings: res, paths: paths, st: st, sun: sa, szen: P.addGlow(P.skyBrightness(sa.el), art) };
    uploadPoints();
    dirty = true;
  }

  // --------------------------------------------------------------- GL
  var canvas = $("sky"), overlay = $("overlay"), octx = overlay.getContext("2d");
  var gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
  var glOK = !!gl, floatOK = false, W = 1, H = 1, dpr = 1;
  var progSky, progPts, progRing, progTone, vaoTri, bufTri, fbo = null, fboTex = null;
  var bufRing = null, nRing = 0, bufStar = null, bufStarCol = null, nStar = 0;
  var bufStation = null, nStation = 0;

  var GLSL_COMMON = [
    "const float DEG = 0.017453292519943295;",
    "float log10f(float x) { return log(x) * 0.4342944819032518; }",
    "float pow10(float x) { return exp(x * 2.302585092994046); }",
    "float ridge(float az) {",
    "  return 0.55*sin(3.0*az+1.3) + 0.35*sin(7.0*az+0.4) + 0.22*sin(13.0*az+2.1)",
    "       + 0.12*sin(29.0*az+0.7) + 0.35; }",
    "vec3 tone(vec3 x) { return pow(x / (1.0 + x), vec3(1.0 / 2.2)); }"
  ].join("\n");

  var VS_TRI = "#version 300 es\nlayout(location=0) in vec2 aPos; out vec2 vNdc;\n" +
    "void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }";

  // Identical to app.js: skymodel.brightness and skymodel.colour, per pixel
  var FS_SKY = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "in vec2 vNdc; out vec4 o;",
    "uniform vec3 uFwd, uRight, uUp, uSun; uniform vec2 uTan;",
    "uniform float uS0, uTwi, uH, uArt, uExposure, uGlowQ, uDirect;",
    "float airmassSK(float alt) {",
    "  float z = clamp(90.0 - max(alt / DEG, 2.0), 0.0, 88.0);",
    "  return 1.0 / (cos(z * DEG) + 0.50572 * pow(96.07995 - z, -1.6364)); }",
    "float airglow(float alt) {",
    "  float z = 1.5707963267948966 - max(alt, 0.5 * DEG);",
    "  float sz = sin(z); float q = uGlowQ * sz * sz;",
    "  float vr = 1.0 / sqrt(max(1.0 - q, 1e-6));",
    "  float ratio = vr * pow10(-0.06 * (airmassSK(alt) - 1.0));",
    "  return -2.5 * log10f(max(ratio, 1e-6)); }",
    "void main() {",
    "  vec3 d = normalize(uFwd + vNdc.x * uTan.x * uRight + vNdc.y * uTan.y * uUp);",
    "  float alt = asin(clamp(d.z, -1.0, 1.0));",
    "  float az = atan(d.x, d.y);",
    "  float ground = alt / DEG < ridge(az) ? 1.0 : 0.0;",
    "  float a = max(alt, 0.0);",
    "  float theta = acos(clamp(dot(d, uSun), -1.0, 1.0)) / DEG;",
    "  float ag = airglow(a);",
    "  float S = uS0 - 3.0 * uTwi * exp(-theta / 28.0) + ag;",
    "  float anti = clamp((theta - 90.0) / 60.0, 0.0, 1.0);",
    "  float e = a / DEG;",
    "  float inside = clamp((uH - e) / 4.0, 0.0, 1.0);",
    "  float u = (e - uH - 4.0) / 5.0;",
    "  S += uTwi * anti * (0.85 * inside - 0.55 * exp(-u * u));",
    "  if (uArt > 0.0) S = -2.5 * log10f(pow10(-0.4 * S) + pow10(-0.4 * (uArt + ag)));",
    "  float w = clamp(exp(-theta / 46.0) * clamp(1.0 - a / (35.0 * DEG), 0.0, 1.0) * (0.15 + 0.85 * uTwi), 0.0, 1.0);",
    "  float ub = (e - uH - 4.0) / 6.0;",
    "  float b = clamp(exp(-ub * ub) * clamp((theta - 100.0) / 60.0, 0.0, 1.0) * uTwi, 0.0, 1.0);",
    "  vec3 c = mix(vec3(0.42, 0.55, 1.0), vec3(1.0, 0.62, 0.34), w);",
    "  c = mix(c, vec3(1.0, 0.68, 0.72), b);",
    "  vec3 v = pow10(-0.4 * (S - 21.7)) * uExposure * c;",
    "  if (ground > 0.5) v = vec3((v.r + v.g + v.b) / 3.0) * 0.018 * vec3(1.0, 0.94, 0.86);",
    "  o = vec4(uDirect > 0.5 ? tone(v) : v, 1.0);",
    "}"].join("\n");

  // Identical to app.js: stars as Gaussian point sources
  var VS_PTS = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "layout(location=0) in vec3 aDir; layout(location=1) in float aMag; layout(location=2) in vec3 aCol;",
    "uniform vec3 uFwd, uRight, uUp; uniform vec2 uTan;",
    "uniform float uFluxK, uSigma, uMaxR;",
    "out float vPeak; out vec3 vCol; out float vSize;",
    "void main() {",
    "  float z = dot(aDir, uFwd);",
    "  float peak = uFluxK * exp2(-1.3287712379549449 * (aMag - 21.7));",
    "  float r = min(uSigma * sqrt(2.0 * log(max(peak / 0.0015, 1.0))), uMaxR);",
    "  float alt = asin(clamp(aDir.z, -1.0, 1.0)) / DEG;",
    "  bool hide = z <= 0.02 || r < 0.35 || alt < ridge(atan(aDir.x, aDir.y));",
    "  vec2 ndc = vec2(dot(aDir, uRight), dot(aDir, uUp)) / (max(z, 0.02) * uTan);",
    "  gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(ndc, 0.0, 1.0);",
    "  vSize = 2.0 * ceil(r) + 1.0;",
    "  gl_PointSize = hide ? 0.0 : vSize;",
    "  vPeak = peak; vCol = aCol;",
    "}"].join("\n");

  var FS_PTS = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "in float vPeak; in vec3 vCol; in float vSize; out vec4 o;",
    "uniform float uSigma, uDirect;",
    "void main() {",
    "  vec2 p = (gl_PointCoord - 0.5) * vSize;",
    "  vec3 v = vCol * vPeak * exp(-dot(p, p) / (2.0 * uSigma * uSigma));",
    "  o = vec4(uDirect > 0.5 ? tone(v) : v, 1.0);",
    "}"].join("\n");

  // Ring samples. Each carries only a sliver of light, so unlike a star it
  // is always drawn (no per-point cutoff) and the additive blend builds the
  // line. aWid is the ring's angular width at the sample: where that is
  // wider than the normal line, the sample's light is spread over a Gaussian
  // whose FWHM matches it, keeping the sample's total, so a wide nearby ring
  // becomes a band that dims as it widens. The footprint is capped at uMaxR
  // (point sprites have a size limit), beyond which bands stop widening.
  var VS_RING = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "layout(location=0) in vec3 aDir; layout(location=1) in float aMag; layout(location=3) in float aWid;",
    "uniform vec3 uFwd, uRight, uUp; uniform vec2 uTan;",
    "uniform float uFluxK, uSigma, uMaxR, uPixRad;",
    "out float vPeak; out float vSize; out float vSig;",
    "void main() {",
    "  float z = dot(aDir, uFwd);",
    "  float sig = clamp(aWid / uPixRad / 2.3548, uSigma, uMaxR / 2.5);",
    "  float peak = uFluxK * exp2(-1.3287712379549449 * (aMag - 21.7)) * (uSigma * uSigma) / (sig * sig);",
    "  float r = 2.5 * sig;",
    "  float alt = asin(clamp(aDir.z, -1.0, 1.0)) / DEG;",
    "  bool hide = z <= 0.02 || alt < ridge(atan(aDir.x, aDir.y));",
    "  vec2 ndc = vec2(dot(aDir, uRight), dot(aDir, uUp)) / (max(z, 0.02) * uTan);",
    "  gl_Position = hide ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(ndc, 0.0, 1.0);",
    "  vSize = 2.0 * ceil(r) + 1.0;",
    "  gl_PointSize = hide ? 0.0 : vSize;",
    "  vPeak = peak; vSig = sig;",
    "}"].join("\n");

  var FS_RING = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "in float vPeak; in float vSize; in float vSig; out vec4 o;",
    "uniform vec3 uCol; uniform float uDirect;",
    "void main() {",
    "  vec2 p = (gl_PointCoord - 0.5) * vSize;",
    "  vec3 v = uCol * vPeak * exp(-dot(p, p) / (2.0 * vSig * vSig));",
    "  o = vec4(uDirect > 0.5 ? tone(v) : v, 1.0);",
    "}"].join("\n");

  var FS_TONE ="#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
    "uniform sampler2D uTex; out vec4 o;",
    "void main() {",
    "  vec3 x = texelFetch(uTex, ivec2(gl_FragCoord.xy), 0).rgb;",
    "  float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);",
    "  o = vec4(tone(max(x, 0.0)) + (n - 0.5) / 255.0, 1.0);",
    "}"].join("\n");

  function compile(vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    p.u = {};
    var n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (var i = 0; i < n; i++) { var nm = gl.getActiveUniform(p, i).name; p.u[nm] = gl.getUniformLocation(p, nm); }
    return p;
  }

  function initGL() {
    if (!glOK) { fatal("This page needs WebGL 2, which this browser does not provide. The numbers still work."); return; }
    try {
      floatOK = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
      progSky = compile(VS_TRI, FS_SKY);
      progPts = compile(VS_PTS, FS_PTS);
      progRing = compile(VS_RING, FS_RING);
      progTone = compile(VS_TRI, FS_TONE);
    } catch (err) { glOK = false; fatal("WebGL setup failed: " + err.message); return; }
    vaoTri = gl.createVertexArray(); gl.bindVertexArray(vaoTri);
    bufTri = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufTri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    bufRing = gl.createBuffer(); bufStar = gl.createBuffer(); bufStarCol = gl.createBuffer();
    bufStation = gl.createBuffer();
  }

  function makeFBO() {
    if (!glOK || !floatOK) return;
    if (fbo) { gl.deleteFramebuffer(fbo); gl.deleteTexture(fboTex); }
    fboTex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, W, H, 0, gl.RGBA, gl.HALF_FLOAT, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    fbo = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, fboTex, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) floatOK = false;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function uploadPoints() {
    if (!glOK || !R) return;
    // all rings and cables share one buffer: they are drawn the same way, in white
    var total = 0;
    R.rings.forEach(function (r) { total += r.draw.length; });
    var all = new Float32Array(total), off = 0;
    R.rings.forEach(function (r) { all.set(r.draw, off); off += r.draw.length; });
    gl.bindBuffer(gl.ARRAY_BUFFER, bufRing);
    gl.bufferData(gl.ARRAY_BUFFER, all, gl.DYNAMIC_DRAW);
    nRing = total / 5;                     // [east, north, up, V, width]
    // stations are point sources, drawn like stars: [east, north, up, V]
    var sTotal = 0;
    R.rings.forEach(function (r) { sTotal += r.stationDraw.length; });
    var sAll = new Float32Array(sTotal), sOff = 0;
    R.rings.forEach(function (r) { sAll.set(r.stationDraw, sOff); sOff += r.stationDraw.length; });
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStation);
    gl.bufferData(gl.ARRAY_BUFFER, sAll, gl.DYNAMIC_DRAW);
    nStation = sTotal / 4;
    var s = R.st.draw;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStar);
    gl.bufferData(gl.ARRAY_BUFFER, s.a.subarray(0, s.n), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStarCol);
    gl.bufferData(gl.ARRAY_BUFFER, R.st.rgb, gl.DYNAMIC_DRAW);
    nStar = s.n / 4;
  }

  function camera() {
    var a = S.az * DEG, e = clamp(S.el, -10, 89.5) * DEG;
    var fwd = [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
    var right = [fwd[1], -fwd[0], 0], rn = Math.hypot(right[0], right[1]);
    right = [right[0] / rn, right[1] / rn, 0];
    var up = [right[1] * fwd[2] - right[2] * fwd[1], right[2] * fwd[0] - right[0] * fwd[2],
              right[0] * fwd[1] - right[1] * fwd[0]];
    var th = Math.tan(S.fov * DEG / 2);
    return { fwd: fwd, right: right, up: up, tanH: th, tanV: th * H / W };
  }
  function ridgeDeg(az) {
    return 0.55 * Math.sin(3 * az + 1.3) + 0.35 * Math.sin(7 * az + 0.4) +
      0.22 * Math.sin(13 * az + 2.1) + 0.12 * Math.sin(29 * az + 0.7) + 0.35;
  }

  function draw() {
    if (!glOK || !R) return;
    var cam = camera();
    var sa = R.sun, sEl = sa.el * DEG;
    var sunENU = [Math.cos(sEl) * Math.sin(sa.az), Math.cos(sEl) * Math.cos(sa.az), Math.sin(sEl)];
    var ctx = P.skyContext(sa.el, P.BORTLE[S.bortle]);
    var exposure = 0.028 * Math.pow(Math.pow(10, -0.4 * (21.7 - R.szen)), 0.72);
    var direct = floatOK ? 0 : 1;
    var cssW = W / dpr, sigmaK = Math.max(dpr * clamp(cssW / 1400, 0.5, 1.25), 0.9);

    gl.bindFramebuffer(gl.FRAMEBUFFER, floatOK ? fbo : null);
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.useProgram(progSky);
    var u = progSky.u;
    gl.uniform3fv(u.uFwd, cam.fwd); gl.uniform3fv(u.uRight, cam.right); gl.uniform3fv(u.uUp, cam.up);
    gl.uniform3fv(u.uSun, sunENU); gl.uniform2f(u.uTan, cam.tanH, cam.tanV);
    gl.uniform1f(u.uS0, ctx.S0); gl.uniform1f(u.uTwi, ctx.twi); gl.uniform1f(u.uH, ctx.h);
    gl.uniform1f(u.uArt, ctx.art === null ? -1 : ctx.art); gl.uniform1f(u.uExposure, exposure);
    gl.uniform1f(u.uGlowQ, P.SKY.GLOW_Q); gl.uniform1f(u.uDirect, direct);
    gl.bindVertexArray(vaoTri); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);

    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progPts); u = progPts.u;
    gl.uniform3fv(u.uFwd, cam.fwd); gl.uniform3fv(u.uRight, cam.right); gl.uniform3fv(u.uUp, cam.up);
    gl.uniform2f(u.uTan, cam.tanH, cam.tanV); gl.uniform1f(u.uDirect, direct);
    var maxR = Math.min(28, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] / 2 - 1);
    gl.uniform1f(u.uMaxR, maxR);

    if (nStar) {
      gl.uniform1f(u.uSigma, SIGMA_STAR * sigmaK);
      gl.uniform1f(u.uFluxK, exposure / PIX_REF / (2 * Math.PI * SIGMA_STAR * SIGMA_STAR));
      gl.bindBuffer(gl.ARRAY_BUFFER, bufStar);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.bindBuffer(gl.ARRAY_BUFFER, bufStarCol);
      gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      gl.drawArrays(gl.POINTS, 0, nStar);
      gl.disableVertexAttribArray(2);
    }
    if (nStation) {
      // same point-source rendering as the stars, in the rings' white
      gl.uniform1f(u.uSigma, SIGMA_RING * sigmaK);
      gl.uniform1f(u.uFluxK, exposure / PIX_REF / (2 * Math.PI * SIGMA_RING * SIGMA_RING));
      gl.bindBuffer(gl.ARRAY_BUFFER, bufStation);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      gl.vertexAttrib3f(2, 0.95, 0.97, 1.0);
      gl.drawArrays(gl.POINTS, 0, nStation);
    }

    // Stars keep the video's peak brightness at every zoom (see PIX_REF).
    // A line has to follow the same rule, or zooming out would crowd more
    // ring into each pixel and brighten it. So the ring's light is scaled
    // from this screen's pixel to the reference pixel, and by the footprint
    // stretch sigmaK, which leaves its cross-section peak where it would be
    // in the video frame.
    if (nRing) {
      var pixRad = 2 * cam.tanH / W, pixArcsec = pixRad / DEG * 3600;
      var ringGain = Math.sqrt(PIX_REF) / (pixArcsec * sigmaK);
      gl.useProgram(progRing); u = progRing.u;
      gl.uniform3fv(u.uFwd, cam.fwd); gl.uniform3fv(u.uRight, cam.right); gl.uniform3fv(u.uUp, cam.up);
      gl.uniform2f(u.uTan, cam.tanH, cam.tanV); gl.uniform1f(u.uDirect, direct);
      gl.uniform1f(u.uMaxR, Math.min(96, gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] / 2 - 1));
      gl.uniform1f(u.uSigma, SIGMA_RING * sigmaK);
      gl.uniform1f(u.uPixRad, pixRad);
      gl.uniform3f(u.uCol, 0.95, 0.97, 1.0);
      gl.uniform1f(u.uFluxK, ringGain * exposure / PIX_REF / (2 * Math.PI * SIGMA_RING * SIGMA_RING));
      gl.bindBuffer(gl.ARRAY_BUFFER, bufRing);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 12);
      gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 20, 16);
      gl.drawArrays(gl.POINTS, 0, nRing);
      gl.disableVertexAttribArray(3);
    }
    gl.disableVertexAttribArray(0); gl.disableVertexAttribArray(1); gl.disableVertexAttribArray(2);
    gl.disable(gl.BLEND);

    if (floatOK) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(progTone);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, fboTex);
      gl.uniform1i(progTone.u.uTex, 0);
      gl.bindVertexArray(vaoTri); gl.drawArrays(gl.TRIANGLES, 0, 3); gl.bindVertexArray(null);
    }
    drawOverlay(cam);
  }

  // ---------------------------------------------------------- overlay
  function project(cam, d) {
    var z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
    if (z <= 0.02) return null;
    var x = (d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2]) / (z * cam.tanH);
    var y = (d[0] * cam.up[0] + d[1] * cam.up[1] + d[2] * cam.up[2]) / (z * cam.tanV);
    return [(x + 1) / 2 * W, (1 - y) / 2 * H];
  }

  // Each ring's path in its colour and dash: solid where sunlit, dotted where
  // in Earth's shadow, numbered at its highest point. Cables get the same
  // treatment and stations a small circle, filled when sunlit. This is a
  // guide to where things are, drawn on top of the sky, not part of the
  // simulation.
  function drawPaths(cam, fs) {
    if (!R.paths) return;
    R.paths.forEach(function (p, i) {
      var col = RING_COLORS[i % RING_COLORS.length], top = null;
      function stroke(arr, closed, litPass) {
        octx.beginPath();
        var prev = null, last = closed ? arr.length : arr.length - 4;
        for (var k = 0; k <= last; k += 4) {
          var j = k % arr.length;
          var ok = !isNaN(arr[j]) && arr[j + 3] === litPass;
          var q = ok ? project(cam, [arr[j], arr[j + 1], arr[j + 2]]) : null;
          if (q && prev && Math.abs(q[0] - prev[0]) < W / 2) octx.lineTo(q[0], q[1]);
          else if (q) octx.moveTo(q[0], q[1]);
          prev = q;
          if (closed && q && (!top || arr[j + 2] > top.u)) top = { u: arr[j + 2], q: q };
        }
        octx.stroke();
      }
      octx.strokeStyle = col;
      octx.lineWidth = 1.1 * dpr;
      [1, 0].forEach(function (litPass) {
        // faint where sunlit, so it does not tint the simulated ring under it
        octx.globalAlpha = litPass ? 0.22 : 0.45;
        octx.setLineDash(litPass
          ? (RING_DASH[i] ? RING_DASH[i].split(" ").map(function (v) { return v * dpr * 1.5; }) : [])
          : [1 * dpr, 4 * dpr]);
        stroke(p.ring, true, litPass);
        p.cables.forEach(function (c) { stroke(c, false, litPass); });
      });
      octx.setLineDash([]);
      for (var k = 0; k < p.stations.length; k += 4) {
        if (isNaN(p.stations[k])) continue;
        var q = project(cam, [p.stations[k], p.stations[k + 1], p.stations[k + 2]]);
        if (!q) continue;
        octx.globalAlpha = 0.7;
        octx.beginPath(); octx.arc(q[0], q[1], 5 * dpr, 0, 2 * Math.PI); octx.stroke();
        if (p.stations[k + 3]) { octx.globalAlpha = 0.25; octx.fillStyle = col; octx.fill(); }
      }
      octx.globalAlpha = 1;
      if (top && top.q[0] > fs && top.q[0] < W - fs && top.q[1] > fs && top.q[1] < H - fs) {
        octx.lineWidth = 3 * dpr; octx.strokeStyle = "rgba(6,8,14,0.85)";
        octx.strokeText(String(i + 1), top.q[0], top.q[1] - fs - 3 * dpr);
        octx.fillStyle = col;
        octx.fillText(String(i + 1), top.q[0], top.q[1] - fs - 3 * dpr);
      }
    });
  }

  function drawOverlay(cam) {
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, W, H);
    var fs = Math.round(12.5 * dpr);
    octx.font = fs + "px system-ui, -apple-system, Helvetica, Arial, sans-serif";
    octx.textAlign = "center"; octx.textBaseline = "top";
    octx.lineJoin = "round";

    if (S.grid) {
      octx.setLineDash([2 * dpr, 5 * dpr]);
      octx.strokeStyle = "rgba(170,185,210,0.28)"; octx.lineWidth = dpr;
      [15, 30, 45, 60, 75].forEach(function (alt) {
        var ca = Math.cos(alt * DEG), sa = Math.sin(alt * DEG), prev = null;
        octx.beginPath();
        for (var az = 0; az <= 360; az += 1.5) {
          var p = project(cam, [ca * Math.sin(az * DEG), ca * Math.cos(az * DEG), sa]);
          if (p && prev) octx.lineTo(p[0], p[1]); else if (p) octx.moveTo(p[0], p[1]);
          prev = p;
        }
        octx.stroke();
        var lp = project(cam, [ca * Math.sin(S.az * DEG), ca * Math.cos(S.az * DEG), sa]);
        if (lp && lp[1] > fs && lp[1] < H - 3 * fs) {
          octx.fillStyle = "rgba(190,203,224,0.75)";
          octx.fillText(alt + "°", lp[0] + 16 * dpr, lp[1] - fs - 2 * dpr);
        }
      });
      octx.setLineDash([]);
    }

    drawPaths(cam, fs);

    for (var i = 0; i < 16; i++) {
      var a = i * 22.5 * DEG;
      var p = project(cam, [Math.sin(a), Math.cos(a), 0]);
      if (!p || p[0] < 4 || p[0] > W - 4) continue;
      var major = i % 2 === 0;
      var yTop = clamp(p[1] + 4 * dpr, 4 * dpr, H - fs - (major ? 20 : 14) * dpr);
      var len = (major ? 11 : 7) * dpr;
      octx.strokeStyle = major ? "rgba(214,226,244,0.9)" : "rgba(190,202,222,0.65)";
      octx.lineWidth = (major ? 2 : 1) * dpr;
      octx.beginPath(); octx.moveTo(p[0], yTop); octx.lineTo(p[0], yTop + len); octx.stroke();
      octx.lineWidth = 3 * dpr; octx.strokeStyle = "rgba(6,8,14,0.8)";
      octx.strokeText(POINTS16[i], p[0], yTop + len + 3 * dpr);
      octx.fillStyle = major ? "rgba(222,232,248,0.96)" : "rgba(198,210,230,0.8)";
      octx.fillText(POINTS16[i], p[0], yTop + len + 3 * dpr);
    }
  }

  // ----------------------------------------------------------- panels
  function ringStatus(sp, r) {
    if (r.up <= 0) {
      if (sp.inc === 0) {
        return "below your horizon: an equatorial ring this high rises only within " +
          RG.equatorialMaxLat(sp.alt).toFixed(1) + "° of the equator";
      }
      return "below your horizon right now";
    }
    if (r.lit <= 0) return "above the horizon, but in Earth's shadow";
    if (r.visible <= 0) return "sunlit, but too faint to see against this sky";
    var txt = "visible";
    if (r.visible < r.up - 0.5) txt += ", " + (r.lit < r.up - 0.5 ? "part in Earth's shadow" : "part too faint");
    return txt;
  }

  function updatePanels() {
    if (!R) return;
    var tb = $("ringRows"), rows = [], lst = lstNow();
    R.rings.forEach(function (r, i) {
      var sp = S.rings[i], col = RING_COLORS[i % RING_COLORS.length], status = ringStatus(sp, r);
      if (sp.fix) {
        status += "; holds still over the ground";
        if (r.stations.total) {
          status += "; stations: " + r.stations.visible + " of " + r.stations.total + " visible" +
            (r.stations.up > r.stations.visible ? " (" + r.stations.up + " above the horizon)" : "") +
            (r.stationBest !== null ? ", brightest " + r.stationBest.toFixed(1) : "");
        }
        if (r.cable.up > 0) {
          status += "; cables: " + Math.round(r.cable.visible) + "° of " + Math.round(r.cable.up) +
            "° visible" + (r.cable.lit < r.cable.up - 0.5 ? ", lower parts in Earth's shadow" : "");
        }
      } else if (S.prec && sp.inc !== 0 && sp.inc !== 180) {
        status += "; node now at RA " + Math.round(mod(sp.raan + dNode(i, lst), 360)) + "°, drifting " +
          Math.abs(RG.nodeRate(sp)).toFixed(2) + "°/day " + (RG.nodeRate(sp) < 0 ? "west" : "east");
      }
      rows.push("<tr><th scope='row' style='color:" + col + "'>" + (i + 1) + ". " + ringName(sp) + "</th>" +
        "<td>" + Math.round(r.visible) + "°</td><td>" + Math.round(r.up) + "°</td>" +
        "<td>" + (r.best === null ? "–" : r.best.toFixed(1)) + "</td></tr>" +
        "<tr class='status'><td colspan='4'>" + status + "</td></tr>");
    });
    tb.innerHTML = rows.join("");
    $("nStars").textContent = fmt(R.st.count);

    var el = R.sun.el, sunTxt = "Sun " + Math.abs(el).toFixed(1) + "° " +
      (el < 0 ? "below" : "above") + " the horizon. ";
    if (N.kind === "normal") {
      sunTxt += "Sunset " + sunTime(N.ref) + ", sunrise " + sunTime(N.ref + N.len / 60) + ", sun time.";
    } else if (N.kind === "polar_night") {
      sunTxt += "The Sun does not rise at this latitude on this date. Time runs from local solar noon.";
    } else {
      sunTxt += "The Sun does not set at this latitude on this date, so the sky never gets dark.";
    }
    $("sunInfo").textContent = sunTxt;

    var vis = 0, up = 0, lit = 0;
    R.rings.forEach(function (r) { vis += r.visible; up += r.up; lit += r.lit; });
    $("chipView").innerHTML = Math.round(vis) + "° of ring visible<br><span style='color:var(--dim)'>" +
      fmt(R.st.count) + " stars</span>";

    var show = "";
    if (up <= 0) show = "None of these rings rises above the horizon from this latitude right now.";
    else if (el > -3 && vis <= 0) show = "The sky is still too bright. Move later into the night.";
    else if (lit <= 0) show = "The rings above your horizon are all in Earth's shadow at this moment.";
    else if (vis <= 0) show = "The sunlit parts of these rings are too faint to see against this sky.";
    var msg = $("msg");
    msg.textContent = show; msg.style.display = show ? "block" : "none";
    $("btnAim").disabled = !brightest();
  }

  function brightest() {
    var b = null;
    if (!R) return null;
    R.rings.forEach(function (r) { if (r.best !== null && (!b || r.best < b.best)) b = r; });
    return b;
  }

  function updateTimeReadout() {
    var lst = lstNow(), t = S.t, txt = sunTime(lst) + " sun time";
    if (N.kind === "normal") {
      if (t < 0) txt += " &middot; " + Math.round(-t) + " min before sunset";
      else if (t <= N.len / 2) txt += " &middot; " + Math.round(t) + " min after sunset";
      else if (t <= N.len) txt += " &middot; " + Math.round(N.len - t) + " min before sunrise";
      else txt += " &middot; " + Math.round(t - N.len) + " min after sunrise";
    }
    var el = R ? R.sun.el : P.sunAltAz(S.lat, lst, N.dec).el;
    $("timeReadout").innerHTML = txt + " &middot; Sun " + (el < 0 ? "&minus;" : "") + Math.abs(el).toFixed(1) + "&deg;";
    var d = new Date(S.date + "T12:00:00");
    var ds = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    $("chipWhen").innerHTML = ds + " &middot; " + Math.abs(S.lat).toFixed(1) + "&deg; " + (S.lat >= 0 ? "N" : "S") +
      "<br>" + txt;
  }

  // ------------------------------------------------------------ curve
  // Visible arc of each ring through the night, from the coarse rings.
  var curve = { key: "", data: {}, job: 0, done: false };
  function curveKey() {
    return [S.lat, S.date, S.bortle, JSON.stringify(S.rings), S.epoch, S.prec].join("|");
  }
  function startCurve() {
    var key = curveKey();
    if (key === curve.key) return;
    curve = { key: key, data: {}, job: curve.job + 1, done: false };
    var job = curve.job, step = N.kind === "normal" ? 5 : 10;
    var order = [], seen = {};
    [40, 20, 10, 5].forEach(function (s) {
      if (s < step) return;
      for (var t = Math.ceil(N.lo / s) * s; t <= N.hi; t += s) if (!seen[t]) { seen[t] = 1; order.push(t); }
    });
    var coarse = rings().coarse, art = P.BORTLE[S.bortle], i = 0, lastDraw = 0;
    function work() {
      if (job !== curve.job) return;
      var t0 = performance.now();
      while (i < order.length && performance.now() - t0 < 14) {
        var t = order[i++], lst = N.ref + t / 60;
        curve.data[t] = coarse.map(function (r, j) {
          return RG.evaluate(r, { lat: S.lat, lst: lst, dec: N.dec, art: art, dNode: dNode(j, lst) }).visible;
        });
      }
      curve.done = i >= order.length;
      $("curveStatus").textContent = curve.done ? "" : "computing… " + Math.round(100 * i / order.length) + "%";
      if (curve.done || performance.now() - lastDraw > 250) { drawCurve(); lastDraw = performance.now(); }
      if (!curve.done) setTimeout(work, 0);
    }
    setTimeout(work, 0);
  }

  function curvePeak() {
    var best = null;
    Object.keys(curve.data).forEach(function (t) {
      var v = curve.data[t].reduce(function (a, b) { return a + b; }, 0);
      if (v > 0 && (!best || v > best.v)) best = { t: Number(t), v: v };
    });
    return best;
  }

  function drawCurve() {
    var svg = $("curve"), w = svg.clientWidth || 600, h = svg.clientHeight || 130;
    var padL = 44, padR = 20, padT = 8, padB = 22;
    var ts = Object.keys(curve.data).map(Number).sort(function (a, b) { return a - b; });
    function X(t) { return padL + (t - N.lo) / (N.hi - N.lo) * (w - padL - padR); }
    var vmax = 10;
    ts.forEach(function (t) { curve.data[t].forEach(function (v) { vmax = Math.max(vmax, v); }); });
    var top = Math.ceil(vmax / 30) * 30;
    function Y(v) { return padT + (1 - v / top) * (h - padT - padB); }
    var out = [];
    for (var v = 0; v <= top; v += top > 90 ? 60 : 30) {
      var y = Y(v);
      out.push("<line x1='" + padL + "' x2='" + (w - padR) + "' y1='" + y + "' y2='" + y +
        "' stroke='#1b2230' stroke-width='1'/>");
      out.push("<text x='" + (padL - 6) + "' y='" + (y + 4) + "' fill='#8b97a8' font-size='10.5' text-anchor='end'>" +
        v + "°</text>");
    }
    var ticks = [];
    if (N.kind === "normal") { ticks.push([0, "sunset"]); ticks.push([N.len, "sunrise"]); }
    for (var hr = Math.ceil(N.ref + N.lo / 60); hr <= N.ref + N.hi / 60; hr++) {
      var t = (hr - N.ref) * 60;
      if (N.kind === "normal" && (Math.abs(t) < 40 || Math.abs(t - N.len) < 40)) continue;
      if (mod(hr, 3) === 0) ticks.push([t, sunTime(hr).replace(":00", "")]);
    }
    var placed = [];
    ticks = ticks.filter(function (tk) {
      var x = X(tk[0]);
      if (placed.some(function (p) { return Math.abs(p - x) < 46; })) return false;
      placed.push(x); return true;
    });
    ticks.forEach(function (tk) {
      var x = X(tk[0]);
      out.push("<line x1='" + x + "' x2='" + x + "' y1='" + (h - padB) + "' y2='" + (h - padB + 4) + "' stroke='#5c6778'/>");
      out.push("<text x='" + x + "' y='" + (h - 6) + "' fill='#8b97a8' font-size='10.5' text-anchor='middle'>" + tk[1] + "</text>");
    });
    S.rings.forEach(function (sp, i) {
      var d = "";
      ts.forEach(function (t, j) {
        var val = curve.data[t][i];
        if (val === undefined) return;
        d += (j ? "L" : "M") + X(t).toFixed(1) + " " + Y(val).toFixed(1);
      });
      if (d) out.push("<path d='" + d + "' fill='none' stroke='" + RING_COLORS[i % RING_COLORS.length] +
        "' stroke-width='1.8'" + (RING_DASH[i] ? " stroke-dasharray='" + RING_DASH[i] + "'" : "") + "/>");
    });
    var xc = X(S.t);
    out.push("<line x1='" + xc + "' x2='" + xc + "' y1='" + padT + "' y2='" + (h - padB) + "' stroke='#e8eef8' stroke-width='1'/>");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.innerHTML = out.join("");
    $("btnPeak").disabled = !curvePeak();
    drawLegend();
  }

  function drawLegend() {
    $("curveLegend").innerHTML = S.rings.map(function (sp, i) {
      var col = RING_COLORS[i % RING_COLORS.length];
      return "<span><svg width='26' height='8' aria-hidden='true'><line x1='0' x2='26' y1='4' y2='4' stroke='" +
        col + "' stroke-width='2'" + (RING_DASH[i] ? " stroke-dasharray='" + RING_DASH[i] + "'" : "") +
        "/></svg> " + (i + 1) + "</span>";
    }).join("");
  }

  // ------------------------------------------------------- ring editor
  function buildEditor() {
    var host = $("ringEditor");
    host.textContent = "";
    S.rings.forEach(function (sp, i) {
      var fsEl = document.createElement("fieldset");
      fsEl.className = "ring";
      var lg = document.createElement("legend");
      lg.style.color = RING_COLORS[i % RING_COLORS.length];
      lg.textContent = "Ring " + (i + 1);
      fsEl.appendChild(lg);
      var grid = document.createElement("div");
      grid.className = "rgrid";
      var modeId = "ring" + i + "_fix";
      var mlab = document.createElement("label");
      mlab.htmlFor = modeId; mlab.className = "small"; mlab.textContent = "Fixed to";
      var msel = document.createElement("select");
      msel.id = modeId;
      [["0", "the stars"], ["1", "the ground (Birch)"]].forEach(function (o) {
        var op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; msel.appendChild(op);
      });
      msel.value = String(sp.fix);
      msel.addEventListener("change", function () {
        var next = Object.assign({}, S.rings[i], { fix: Number(msel.value) });
        // a new ground-fixed ring gets stations, so the mode shows what it is for
        if (next.fix && !S.rings[i].fix && !next.stations) next.stations = 4;
        S.rings[i] = RG.sanitize(next);
        ringsChanged(true);
        $(modeId).focus();
      });
      grid.appendChild(mlab); grid.appendChild(msel);
      FIELDS.forEach(function (f) {
        if (f.mode && (f.mode === "ground") !== !!sp.fix) return;
        var id = "ring" + i + "_" + f.k;
        var lab = document.createElement("label");
        lab.htmlFor = id; lab.className = "small";
        lab.textContent = f.label + (f.unit ? " (" + f.unit + ")" : "");
        var inp = document.createElement("input");
        inp.type = "number"; inp.id = id; inp.step = f.step;
        inp.min = RG.LIMITS[f.k][0]; inp.max = RG.LIMITS[f.k][1];
        inp.value = sp[f.k];
        if (f.title) inp.title = f.title;
        if (f.k === "raan") inp.disabled = sp.inc === 0;
        inp.addEventListener("change", function () {
          var next = Object.assign({}, S.rings[i]);
          next[f.k] = Number(inp.value);
          S.rings[i] = RG.sanitize(next);
          inp.value = S.rings[i][f.k];
          if (f.k === "inc" && $("ring" + i + "_raan")) $("ring" + i + "_raan").disabled = S.rings[i].inc === 0;
          ringsChanged(false);
        });
        grid.appendChild(lab); grid.appendChild(inp);
      });
      fsEl.appendChild(grid);
      var rm = document.createElement("button");
      rm.type = "button"; rm.textContent = "Remove ring " + (i + 1);
      rm.disabled = S.rings.length <= 1;
      rm.addEventListener("click", function () { S.rings.splice(i, 1); ringsChanged(true); });
      fsEl.appendChild(rm);
      host.appendChild(fsEl);
    });
    $("btnAddRing").disabled = S.rings.length >= MAX_RINGS;
  }

  function ringsChanged(rebuildEditor) {
    if (rebuildEditor) buildEditor();
    startCurve(); physicsChanged();
  }

  // -------------------------------------------------------- the loop
  var dirty = true, playing = false, lastTs = 0, needEval = true, lastCurveT = null;
  function refresh() {
    if (needEval) {
      evaluateNow(); needEval = false; updatePanels(); updateTimeReadout();
      if (S.t !== lastCurveT) { drawCurve(); lastCurveT = S.t; }
    }
    if (dirty) { draw(); dirty = false; }
  }
  function tick(ts) {
    if (playing) {
      // the night passing at 1,440x: one hour of sky every 2.5 seconds
      var dt = Math.min((ts - lastTs) / 1000, 0.25);
      S.t += dt * 24;
      if (S.t > N.hi) S.t = N.lo;
      $("time").value = S.t;
      needEval = true;
    }
    lastTs = ts;
    refresh();
    requestAnimationFrame(tick);
  }

  function physicsChanged() { needEval = true; writeHash(); }
  function nightChanged() {
    var old = N; N = computeNight();
    if (old && old.kind !== N.kind) S.t = N.kind === "normal" ? 120 : 720;
    S.t = clamp(S.t, N.lo, N.hi);
    var tr = $("time"); tr.min = N.lo; tr.max = N.hi; tr.value = S.t;
    startCurve();
    physicsChanged();
  }
  function viewChanged() { dirty = true; writeHash(); }

  // --------------------------------------------------------- controls
  function bindControls() {
    $("version").textContent = "Version " + VERSION;
    $("lat").value = S.lat; $("date").value = S.date; $("bortle").value = S.bortle;
    $("fov").value = S.fov; $("fovOut").textContent = Math.round(S.fov) + "°";
    $("bortleName").textContent = "(" + BORTLE_NAMES[S.bortle] + ")";
    $("paths").checked = S.paths;
    $("prec").checked = S.prec; $("epoch").value = S.epoch;
    latHint();
    $("prec").addEventListener("change", function () { S.prec = this.checked; startCurve(); physicsChanged(); });
    $("epoch").addEventListener("change", function () {
      if (/^\d{4}-\d{2}-\d{2}$/.test(this.value)) { S.epoch = this.value; startCurve(); physicsChanged(); }
    });

    var pre = $("preset");
    Object.keys(PRESETS).forEach(function (k) {
      var o = document.createElement("option"); o.value = k; o.textContent = PRESETS[k].name; pre.appendChild(o);
    });
    pre.addEventListener("change", function () {
      if (!PRESETS[this.value]) return;
      S.rings = PRESETS[this.value].rings.map(RG.sanitize);
      this.value = "";
      ringsChanged(true);
    });
    $("btnAddRing").addEventListener("click", function () {
      if (S.rings.length >= MAX_RINGS) return;
      var last = S.rings[S.rings.length - 1];
      S.rings.push(RG.sanitize(Object.assign({}, last, { alt: Math.min(last.alt * 2, RG.LIMITS.alt[1]) })));
      ringsChanged(true);
    });

    $("time").addEventListener("input", function () { S.t = Number(this.value); physicsChanged(); });
    $("date").addEventListener("change", function () {
      if (/^\d{4}-\d{2}-\d{2}$/.test(this.value)) { S.date = this.value; nightChanged(); }
    });
    Array.prototype.forEach.call(document.querySelectorAll("[data-md]"), function (b) {
      b.addEventListener("click", function () {
        var md = b.dataset.md.split("-").map(Number), y = S.date.slice(0, 4);
        S.date = y + "-" + (md[0] < 10 ? "0" : "") + md[0] + "-" + (md[1] < 10 ? "0" : "") + md[1];
        $("date").value = S.date; nightChanged();
      });
    });
    $("lat").addEventListener("change", function () {
      var v = parseFloat(this.value);
      if (!isFinite(v)) { this.value = S.lat; return; }
      S.lat = Math.round(clamp(v, -89, 89) * 10) / 10; this.value = S.lat; latHint(); nightChanged();
    });
    $("btnGeo").addEventListener("click", function () {
      var btn = this;
      if (!navigator.geolocation) { btn.textContent = "Not available"; return; }
      btn.textContent = "Locating…";
      navigator.geolocation.getCurrentPosition(function (pos) {
        S.lat = Math.round(pos.coords.latitude * 10) / 10; $("lat").value = S.lat; latHint();
        btn.textContent = "Use my location"; nightChanged();
      }, function () { btn.textContent = "Location unavailable"; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 3600000 });
    });
    $("bortle").addEventListener("input", function () {
      S.bortle = Number(this.value); $("bortleName").textContent = "(" + BORTLE_NAMES[S.bortle] + ")";
      startCurve(); physicsChanged();
    });
    $("fov").addEventListener("input", function () {
      S.fov = Number(this.value); $("fovOut").textContent = Math.round(S.fov) + "°"; viewChanged();
    });
    $("grid").addEventListener("change", function () { S.grid = this.checked; dirty = true; });
    $("paths").addEventListener("change", function () { S.paths = this.checked; needEval = true; });
    $("btnPlay").addEventListener("click", function () {
      playing = !playing; this.textContent = playing ? "Pause" : "Play";
      this.setAttribute("aria-pressed", String(playing));
    });
    $("btnAim").addEventListener("click", function () { aimAtBrightest(); viewChanged(); });
    $("btnFull").addEventListener("click", function () {
      var el = $("skywrap");
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen();
    });
    $("btnPeak").addEventListener("click", function () {
      var pk = curvePeak();
      if (!pk) return;
      S.t = pk.t; $("time").value = S.t; physicsChanged();
    });
    $("curve").addEventListener("click", function (ev) {
      var r = this.getBoundingClientRect(), w = r.width, padL = 44, padR = 20;
      var t = N.lo + (ev.clientX - r.left - padL) / (w - padL - padR) * (N.hi - N.lo);
      S.t = Math.round(clamp(t, N.lo, N.hi)); $("time").value = S.t; physicsChanged();
    });

    // drag, wheel and pinch on the sky; arrow keys for keyboard users
    var wrap = $("skywrap"), ptrs = {}, pinch0 = null;
    wrap.addEventListener("keydown", function (e) {
      var step = S.fov / 20, used = true;
      if (e.key === "ArrowLeft") S.az = mod(S.az - step, 360);
      else if (e.key === "ArrowRight") S.az = mod(S.az + step, 360);
      else if (e.key === "ArrowUp") S.el = clamp(S.el + step, -10, 89.5);
      else if (e.key === "ArrowDown") S.el = clamp(S.el - step, -10, 89.5);
      else if (e.key === "+" || e.key === "=") S.fov = clamp(S.fov / 1.1, 20, 120);
      else if (e.key === "-") S.fov = clamp(S.fov * 1.1, 20, 120);
      else used = false;
      if (used) { e.preventDefault(); $("fov").value = S.fov; $("fovOut").textContent = Math.round(S.fov) + "°"; viewChanged(); }
    });
    wrap.addEventListener("pointerdown", function (e) {
      if (e.target.tagName === "BUTTON") return;
      wrap.setPointerCapture(e.pointerId); ptrs[e.pointerId] = [e.clientX, e.clientY];
      wrap.classList.add("dragging");
      var ids = Object.keys(ptrs);
      if (ids.length === 2) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]];
        pinch0 = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), fov: S.fov };
      }
    });
    wrap.addEventListener("pointermove", function (e) {
      var rect = wrap.getBoundingClientRect();
      if (!ptrs[e.pointerId]) { showCursor(e.clientX - rect.left, e.clientY - rect.top, rect); return; }
      var prev = ptrs[e.pointerId], dx = e.clientX - prev[0], dy = e.clientY - prev[1];
      ptrs[e.pointerId] = [e.clientX, e.clientY];
      var ids = Object.keys(ptrs);
      if (ids.length === 2 && pinch0) {
        var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        S.fov = clamp(pinch0.fov * pinch0.d / Math.max(d, 1), 20, 120);
        $("fov").value = S.fov; $("fovOut").textContent = Math.round(S.fov) + "°";
      } else if (ids.length === 1) {
        var degPerPx = S.fov / rect.width;
        S.az = mod(S.az - dx * degPerPx, 360);
        S.el = clamp(S.el + dy * degPerPx, -10, 89.5);
      }
      viewChanged();
    });
    function up(e) {
      delete ptrs[e.pointerId]; pinch0 = null;
      if (!Object.keys(ptrs).length) wrap.classList.remove("dragging");
    }
    wrap.addEventListener("pointerup", up); wrap.addEventListener("pointercancel", up);
    wrap.addEventListener("pointerleave", function () { $("chipCursor").style.display = "none"; });
    wrap.addEventListener("wheel", function (e) {
      e.preventDefault();
      S.fov = clamp(S.fov * Math.exp(e.deltaY * 0.0012), 20, 120);
      $("fov").value = S.fov; $("fovOut").textContent = Math.round(S.fov) + "°";
      viewChanged();
    }, { passive: false });

    function showCursor(px, py, rect) {
      var cam = camera(), x = (px / rect.width) * 2 - 1, y = 1 - (py / rect.height) * 2;
      var d = [cam.fwd[0] + x * cam.tanH * cam.right[0] + y * cam.tanV * cam.up[0],
               cam.fwd[1] + x * cam.tanH * cam.right[1] + y * cam.tanV * cam.up[1],
               cam.fwd[2] + x * cam.tanH * cam.right[2] + y * cam.tanV * cam.up[2]];
      var n = Math.hypot(d[0], d[1], d[2]);
      var alt = Math.asin(d[2] / n) / DEG, az = mod(Math.atan2(d[0], d[1]) / DEG, 360);
      var c = $("chipCursor");
      c.style.display = "block";
      c.textContent = "altitude " + Math.round(alt) + "° · heading " + Math.round(az) + "° " + pointName(az);
    }

    new ResizeObserver(resize).observe(wrap);
    document.addEventListener("fullscreenchange", resize);
    window.addEventListener("resize", function () { drawCurve(); });
  }

  // Turn to the brightest visible patch of ring, keeping some horizon in view.
  function aimAtBrightest() {
    var b = brightest();
    if (!b) return false;
    var d = b.bestDir;
    S.az = mod(Math.atan2(d[0], d[1]) / DEG, 360);
    S.el = clamp(Math.asin(clamp(d[2], -1, 1)) / DEG, 15, 75);
    return true;
  }

  function latHint() {
    $("latNS").textContent = "° " + (S.lat >= 0 ? "N" : "S") + (S.lat < 0 ? " (" + Math.abs(S.lat) + "° south)" : "");
  }
  function resize() {
    var r = $("skywrap").getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    canvas.width = W; canvas.height = H; overlay.width = W; overlay.height = H;
    makeFBO(); dirty = true;
  }

  // ------------------------------------------------------------- go
  initGL();
  N = computeNight();
  bindControls();
  buildEditor();
  resize();
  S.t = clamp(S.t, N.lo, N.hi);
  $("time").min = N.lo; $("time").max = N.hi; $("time").value = S.t;
  evaluateNow(); needEval = false;
  if (!elFromHash && H > W) {
    var vHalf = Math.atan(Math.tan(S.fov * DEG / 2) * H / W) / DEG;
    S.el = clamp(vHalf - 12, 25, 60);
  }
  if (autoAim) aimAtBrightest();
  updatePanels(); updateTimeReadout();
  startCurve();
  writeHash();
  requestAnimationFrame(tick);
  window.__rings = { S: S, get R() { return R; }, get curve() { return curve; } };
})();

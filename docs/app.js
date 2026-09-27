/*
 * The browser front end: controls, the WebGL sky, the night curve and the
 * numbers. No physics lives here; it all comes from physics.js.
 *
 * Rendering follows frame.py so the picture looks like the published video:
 * everything is accumulated in linear flux relative to a dark sky, point
 * sources are Gaussians whose peak matches the video's pixel scale, and the
 * same partial eye-adaptation and Reinhard curve map it to the screen.
 */
(function () {
  "use strict";

  var VERSION = "2026-09-27";
  var P = window.ODC;
  var DEG = Math.PI / 180;
  var POINTS16 = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
                  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  var BORTLE_NAMES = { 1: "1, pristine dark site", 2: "2, dark site", 3: "3, rural",
    4: "4, rural to suburban", 5: "5, suburban", 6: "6, bright suburban",
    7: "7, suburban to urban", 8: "8, city" };
  var MOTION = { sats10: { kind: "sats", speed: 10 }, sats60: { kind: "sats", speed: 60 },
                 night: { kind: "night", speed: 1440 } };
  // frame.py reference: 95 degrees across 1,672 pixels. Point sources keep
  // the video's peak brightness at every zoom and screen size.
  var PIX_REF = Math.pow(95.0 * 3600.0 / 1672.0, 2);
  var SIGMA_SAT = 1.0, SIGMA_STAR = 1.15;

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

  // ------------------------------------------------------------- state
  var S = { lat: 37.2, date: todayISO(), t: 80, model: "boley", bortle: 1, n: 500000,
            spread: 10, az: 315, el: 25, fov: 90, grid: false, motion: "sats10" };
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
    if (q.m === "boley" || q.m === "mini") S.model = q.m;
    if ((v = num("b", 1, 8)) !== null) S.bortle = Math.round(v);
    if ((v = num("n", 1000, 500000)) !== null) S.n = Math.round(v);
    if (q.sp === "30" || q.sp === "10") S.spread = Number(q.sp);
    if ((v = num("fov", 20, 120)) !== null) S.fov = v;
    if ((v = num("el", -10, 89.5)) !== null) { S.el = v; elFromHash = true; }
    if ((v = num("az", 0, 360)) !== null) { S.az = v; autoAim = false; }
  })();

  var hashTimer = null;
  function writeHash() {
    clearTimeout(hashTimer);
    hashTimer = setTimeout(function () {
      var s = "lat=" + S.lat + "&date=" + S.date + "&t=" + Math.round(S.t) + "&m=" + S.model +
        "&b=" + S.bortle + "&n=" + S.n + "&sp=" + S.spread + "&az=" + Math.round(S.az) +
        "&el=" + Math.round(S.el) + "&fov=" + Math.round(S.fov);
      history.replaceState(null, "", "#" + s);
    }, 300);
  }

  // -------------------------------------------------------------- data
  var man = window.ODC_MANIFEST;
  if (!man || !window.ODC_BLOB || !P) { fatal("The data file did not load."); return; }
  var buf = P.decodeBase64(window.ODC_BLOB);
  var stars = P.loadStars(man, buf);
  var consCache = {};
  function cons() {
    var k = String(S.spread);
    if (!consCache[k]) consCache[k] = P.loadConstellation(man, buf, k);
    return consCache[k];
  }

  // The night for this latitude and date. Time is minutes after sunset, or
  // after local solar noon where the Sun does not set or rise.
  var N = null;
  function computeNight() {
    var ymd = S.date.split("-").map(Number);
    var sun = P.sun(ymd[0], ymd[1], ymd[2]);
    var ss = P.sunset(S.lat, sun.dec);
    var n = { dec: sun.dec, ra: sun.ra, kind: ss.kind };
    if (ss.kind === "normal") {
      n.ref = ss.lst;
      n.len = (48 - 2 * ss.lst) * 60;          // sunset to next sunrise, minutes
      n.lo = -20; n.hi = Math.round(n.len + 20);
    } else {
      n.ref = 12.0; n.len = 1440; n.lo = 0; n.hi = 1440;
    }
    return n;
  }
  function lstNow() { return N.ref + S.t / 60.0; }

  // ------------------------------------------------------ the instant
  var R = null, orbitT = 0;
  function evaluateNow() {
    var c = cons(), sub = P.subsample(c, S.n), art = P.BORTLE[S.bortle];
    var opts = { lat: S.lat, lst: lstNow(), dec: N.dec, t: orbitT, art: art, sub: sub, local: true };
    var e = P.evaluate(c, opts);
    var st = P.evaluateStars(stars, { lat: S.lat, lst: lstNow(), dec: N.dec, raSun: N.ra, art: art });
    var sa = P.sunAltAz(S.lat, lstNow(), N.dec);
    R = { e: e, st: st, sun: sa, szen: P.addGlow(P.skyBrightness(sa.el), art) };
    uploadPoints();
    dirty = true;
  }

  // --------------------------------------------------------------- GL
  var canvas = $("sky"), overlay = $("overlay"), octx = overlay.getContext("2d");
  var gl = canvas.getContext("webgl2", { antialias: false, alpha: false, preserveDrawingBuffer: true });
  var glOK = !!gl, floatOK = false, W = 1, H = 1, dpr = 1;
  var progSky, progPts, progTone, vaoTri, bufTri, fbo = null, fboTex = null;
  var bufSat = { boley: null, mini: null }, nSat = { boley: 0, mini: 0 };
  var bufStar = null, bufStarCol = null, nStar = 0;

  var GLSL_COMMON = [
    "const float DEG = 0.017453292519943295;",
    "float log10f(float x) { return log(x) * 0.4342944819032518; }",
    "float pow10(float x) { return exp(x * 2.302585092994046); }",
    // the horizon silhouette, degrees, as a function of azimuth
    "float ridge(float az) {",
    "  return 0.55*sin(3.0*az+1.3) + 0.35*sin(7.0*az+0.4) + 0.22*sin(13.0*az+2.1)",
    "       + 0.12*sin(29.0*az+0.7) + 0.35; }",
    "vec3 tone(vec3 x) { return pow(x / (1.0 + x), vec3(1.0 / 2.2)); }"
  ].join("\n");

  var VS_TRI = "#version 300 es\nlayout(location=0) in vec2 aPos; out vec2 vNdc;\n" +
    "void main(){ vNdc = aPos; gl_Position = vec4(aPos, 0.0, 1.0); }";

  // skymodel.brightness and skymodel.colour, per pixel
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

  var FS_TONE = "#version 300 es\nprecision highp float;\n" + GLSL_COMMON + "\n" + [
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
      progTone = compile(VS_TRI, FS_TONE);
    } catch (err) { glOK = false; fatal("WebGL setup failed: " + err.message); return; }
    vaoTri = gl.createVertexArray(); gl.bindVertexArray(vaoTri);
    bufTri = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, bufTri);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    bufSat.boley = gl.createBuffer(); bufSat.mini = gl.createBuffer();
    bufStar = gl.createBuffer(); bufStarCol = gl.createBuffer();
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
    ["boley", "mini"].forEach(function (m) {
      var g = R.e.draw[m];
      gl.bindBuffer(gl.ARRAY_BUFFER, bufSat[m]);
      gl.bufferData(gl.ARRAY_BUFFER, g.a.subarray(0, g.n), gl.DYNAMIC_DRAW);
      nSat[m] = g.n / 4;
    });
    var s = R.st.draw;
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStar);
    gl.bufferData(gl.ARRAY_BUFFER, s.a.subarray(0, s.n), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, bufStarCol);
    gl.bufferData(gl.ARRAY_BUFFER, R.st.rgb, gl.DYNAMIC_DRAW);
    nStar = s.n / 4;
  }

  // Camera: frame.basis, in east/north/up
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

    function pts(buffer, n, sigmaRef, colBuf, col) {
      if (!n) return;
      gl.uniform1f(u.uSigma, sigmaRef * sigmaK);
      gl.uniform1f(u.uFluxK, exposure / PIX_REF / (2 * Math.PI * sigmaRef * sigmaRef));
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 16, 12);
      if (colBuf) {
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 3, gl.FLOAT, false, 0, 0);
      } else { gl.disableVertexAttribArray(2); gl.vertexAttrib3f(2, col[0], col[1], col[2]); }
      gl.drawArrays(gl.POINTS, 0, n);
    }
    pts(bufStar, nStar, SIGMA_STAR, bufStarCol, null);
    pts(bufSat[S.model], nSat[S.model], SIGMA_SAT, null, [0.95, 0.97, 1.0]);
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

  // --------------------------------------------------- counts in view
  function inViewCount(g, cam) {
    if (!g) return 0;
    var a = g.a, n = g.n, c = 0, f = cam.fwd, r = cam.right, u = cam.up;
    for (var i = 0; i < n; i += 4) {
      var x = a[i], y = a[i + 1], z = a[i + 2];
      var zz = x * f[0] + y * f[1] + z * f[2];
      if (zz <= 0.02) continue;
      if (Math.abs((x * r[0] + y * r[1] + z * r[2]) / (zz * cam.tanH)) > 1) continue;
      if (Math.abs((x * u[0] + y * u[1] + z * u[2]) / (zz * cam.tanV)) > 1) continue;
      if (Math.asin(z) / DEG < ridgeDeg(Math.atan2(x, y))) continue;
      c++;
    }
    return c;
  }

  // ----------------------------------------------------------- panels
  function updatePanels() {
    if (!R) return;
    var cam = camera(), sc = R.e.scale;
    var vb = inViewCount(R.e.draw.boley, cam) * sc, vm = inViewCount(R.e.draw.mini, cam) * sc;
    var vs = inViewCount(R.st.draw, cam);
    var nb = R.e.count.boley, nm = R.e.count.mini, ns = R.st.count;
    $("nBoley").textContent = fmt(nb); $("nMini").textContent = fmt(nm); $("nStars").textContent = fmt(ns);
    $("vBoley").textContent = fmt(vb); $("vMini").textContent = fmt(vm); $("vStars").textContent = fmt(vs);
    $("rowBoley").className = "c-boley" + (S.model === "boley" ? " sel" : "");
    $("rowMini").className = "c-mini" + (S.model === "mini" ? " sel" : "");

    var nSel = R.e.count[S.model], ratio = $("ratio"), txt;
    if (nSel < 0.5 && ns === 0) txt = "The sky is still too bright for anything to show.";
    else if (nSel < 0.5) txt = "Nothing from this model is visible anywhere in the sky right now.";
    else if (ns === 0) txt = "No star is visible yet, but " + fmt(nSel) + " satellites are.";
    else if (nSel >= ns) {
      var r1 = nSel / ns;
      txt = "Across the whole sky, satellites outnumber stars <b>" +
        (r1 >= 10 ? fmt(r1) : r1.toFixed(1)) + " to 1</b>.";
    } else {
      var r2 = ns / nSel;
      txt = "Across the whole sky, stars still outnumber satellites <b>" +
        (r2 >= 10 ? fmt(r2) : r2.toFixed(1)) + " to 1</b>.";
    }
    ratio.innerHTML = txt;

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

    var col = S.model === "boley" ? "var(--boley)" : "var(--mini)";
    $("chipView").innerHTML = "<span style='color:" + col + "'>" + fmt(S.model === "boley" ? vb : vm) +
      " satellites</span> &middot; " + fmt(vs) + " stars<br><span style='color:var(--dim)'>in this view</span>";

    var msg = $("msg"), show = "";
    if (N.kind === "midnight_sun") show = "The Sun does not set here on this date. The sky never gets dark enough to see these.";
    else if (el > -3 && nSel < 0.5) show = "The sky is still too bright. Move later into the night.";
    else if (nSel < 0.5 && curve.done) {
      var anyTonight = Object.keys(curve.data).some(function (t) {
        return curve.data[t][S.model === "boley" ? "b" : "m"] >= 0.5; });
      var name = S.model === "boley" ? "the no-mitigation model" : "the optimistic model";
      if (!anyTonight && S.bortle >= 4)
        show = "Under this much light pollution nothing from " + name + " is visible at any time tonight.";
      else if (!anyTonight)
        show = "Nothing from " + name + " is visible at any time tonight at this latitude and date. " +
          "Try another date: the season matters a great deal.";
      else show = "Nothing from " + name + " is visible at this moment. The curve below shows when it is.";
    }
    msg.textContent = show; msg.style.display = show ? "block" : "none";

    var aimable = R.e.hist[S.model] && P.ringAzimuth(R.e.hist[S.model], S.fov) !== null;
    $("btnAim").disabled = !aimable;
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
  var curve = { key: "", data: {}, job: 0, done: false };
  function curveKey() { return [S.lat, S.date, S.bortle, S.n, S.spread].join("|"); }
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
    var c = cons(), sub = P.subsample(c, S.n), art = P.BORTLE[S.bortle], i = 0;
    var lastDraw = 0;
    function work() {
      if (job !== curve.job) return;
      var t0 = performance.now();
      while (i < order.length && performance.now() - t0 < 14) {
        var t = order[i++], lst = N.ref + t / 60;
        var e = P.evaluate(c, { lat: S.lat, lst: lst, dec: N.dec, art: art, sub: sub, local: false });
        var st = P.evaluateStars(stars, { lat: S.lat, lst: lst, dec: N.dec, raSun: N.ra, art: art, countOnly: true });
        curve.data[t] = { b: e.count.boley, m: e.count.mini, s: st.count };
      }
      curve.done = i >= order.length;
      $("curveStatus").textContent = curve.done ? "" : "computing… " + Math.round(100 * i / order.length) + "%";
      if (curve.done || performance.now() - lastDraw > 250) { drawCurve(); lastDraw = performance.now(); }
      if (curve.done) updatePanels();
      if (!curve.done) setTimeout(work, 0);
    }
    setTimeout(work, 0);
  }

  function curvePeaks() {
    var ts = Object.keys(curve.data).map(Number).sort(function (a, b) { return a - b; });
    var k = S.model === "boley" ? "b" : "m", eve = null, morn = null;
    var half = N.kind === "normal" ? N.len / 2 : null;
    ts.forEach(function (t) {
      var v = curve.data[t][k];
      if (v <= 0) return;
      if (half === null || t <= half) { if (!eve || v > eve.v) eve = { t: t, v: v }; }
      else { if (!morn || v > morn.v) morn = { t: t, v: v }; }
    });
    return { eve: eve, morn: morn };
  }

  function drawCurve() {
    var svg = $("curve"), w = svg.clientWidth || 600, h = svg.clientHeight || 130;
    var padL = 54, padR = 20, padT = 8, padB = 22;
    var ts = Object.keys(curve.data).map(Number).sort(function (a, b) { return a - b; });
    function X(t) { return padL + (t - N.lo) / (N.hi - N.lo) * (w - padL - padR); }
    var vmax = 1;
    ts.forEach(function (t) { var d = curve.data[t]; vmax = Math.max(vmax, d.b, d.m, d.s); });
    var top = Math.max(4, Math.ceil(Math.log10(vmax * 1.05)));
    function Y(v) { return padT + (1 - Math.log10(Math.max(v, 1)) / top) * (h - padT - padB); }
    var out = [], yt = [];
    for (var e = 1; e <= top; e++) yt.push(Math.pow(10, e));
    yt.forEach(function (v) {
      var y = Y(v);
      out.push("<line x1='" + padL + "' x2='" + (w - padR) + "' y1='" + y + "' y2='" + y +
        "' stroke='#1b2230' stroke-width='1'/>");
      out.push("<text x='" + (padL - 6) + "' y='" + (y + 4) + "' fill='#8b97a8' font-size='10.5' text-anchor='end'>" +
        fmt(v) + "</text>");
    });
    // time axis: sunset, whole sun-time hours, sunrise
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
    function path(key, color, dash, width) {
      var d = "", pen = false;
      ts.forEach(function (t) {
        var v = curve.data[t][key];
        if (v >= 1) { d += (pen ? "L" : "M") + X(t).toFixed(1) + " " + Y(v).toFixed(1); pen = true; }
        else pen = false;
      });
      if (d) out.push("<path d='" + d + "' fill='none' stroke='" + color + "' stroke-width='" + width +
        "'" + (dash ? " stroke-dasharray='3 3'" : "") + "/>");
    }
    path("s", "#cfd8e8", true, 1.2);
    path("m", "#7ab8ff", false, S.model === "mini" ? 2.2 : 1.3);
    path("b", "#ff9a3c", false, S.model === "boley" ? 2.2 : 1.3);
    var xc = X(S.t);
    out.push("<line x1='" + xc + "' x2='" + xc + "' y1='" + padT + "' y2='" + (h - padB) + "' stroke='#e8eef8' stroke-width='1'/>");
    svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.innerHTML = out.join("");
    var pk = curvePeaks();
    $("btnPeakEve").disabled = !pk.eve; $("btnPeakMorn").disabled = !pk.morn;
    $("btnPeakEve").textContent = N.kind === "normal" ? "Evening peak" : "Peak";
    $("btnPeakMorn").style.display = N.kind === "normal" ? "" : "none";
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
      var dt = Math.min((ts - lastTs) / 1000, 0.25), m = MOTION[S.motion];
      if (m.kind === "sats") orbitT += dt * m.speed;
      else {
        S.t += dt * m.speed / 60;
        if (S.t > N.hi) S.t = N.lo;
        $("time").value = S.t;
      }
      needEval = true;
    }
    lastTs = ts;
    refresh();
    requestAnimationFrame(tick);
  }

  function physicsChanged(resetOrbit) {
    if (resetOrbit !== false) orbitT = 0;
    needEval = true; writeHash();
  }
  function nightChanged() {
    var old = N; N = computeNight();
    if (old && old.kind !== N.kind) S.t = N.kind === "normal" ? 80 : 720;
    S.t = clamp(S.t, N.lo, N.hi);
    var tr = $("time"); tr.min = N.lo; tr.max = N.hi; tr.value = S.t;
    startCurve();
    physicsChanged();
  }
  function viewChanged() { dirty = true; updatePanels(); writeHash(); }

  // --------------------------------------------------------- controls
  function bindControls() {
    $("version").textContent = "Version " + VERSION;
    $("lat").value = S.lat; $("date").value = S.date; $("bortle").value = S.bortle;
    $("nsats").value = String(S.n); $("spread").value = String(S.spread);
    $("fov").value = S.fov; $("fovOut").textContent = Math.round(S.fov) + "°";
    $("bortleName").textContent = "(" + BORTLE_NAMES[S.bortle] + ")";
    $("motion").value = S.motion;
    latHint();
    function segUpdate() {
      Array.prototype.forEach.call(document.querySelectorAll("#modelSeg button"), function (b) {
        b.classList.toggle("on", b.dataset.model === S.model);
      });
    }
    segUpdate();

    $("time").addEventListener("input", function () {
      S.t = Number(this.value); physicsChanged();
    });
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
    Array.prototype.forEach.call(document.querySelectorAll("#modelSeg button"), function (b) {
      b.addEventListener("click", function () {
        S.model = b.dataset.model; segUpdate(); dirty = true; updatePanels(); drawCurve(); writeHash();
      });
    });
    $("bortle").addEventListener("input", function () {
      S.bortle = Number(this.value); $("bortleName").textContent = "(" + BORTLE_NAMES[S.bortle] + ")";
      startCurve(); physicsChanged();
    });
    $("nsats").addEventListener("change", function () { S.n = Number(this.value); startCurve(); physicsChanged(); });
    $("spread").addEventListener("change", function () {
      S.spread = Number(this.value); startCurve(); physicsChanged();
    });
    $("fov").addEventListener("input", function () {
      S.fov = Number(this.value); $("fovOut").textContent = Math.round(S.fov) + "°"; viewChanged();
    });
    $("grid").addEventListener("change", function () { S.grid = this.checked; dirty = true; });
    $("motion").addEventListener("change", function () { S.motion = this.value; orbitT = 0; needEval = true; });
    $("btnPlay").addEventListener("click", function () {
      playing = !playing; this.textContent = playing ? "Pause" : "Play";
      if (!playing) { needEval = true; }
    });
    $("btnAim").addEventListener("click", function () {
      if (!R) return;
      var az = P.ringAzimuth(R.e.hist[S.model], S.fov);
      if (az !== null) { S.az = az; viewChanged(); }
    });
    $("btnFull").addEventListener("click", function () {
      var el = $("skywrap");
      if (document.fullscreenElement) document.exitFullscreen();
      else if (el.requestFullscreen) el.requestFullscreen();
    });
    function jump(which) {
      var pk = curvePeaks()[which];
      if (!pk) return;
      S.t = pk.t; $("time").value = S.t; physicsChanged();
    }
    $("btnPeakEve").addEventListener("click", function () { jump("eve"); });
    $("btnPeakMorn").addEventListener("click", function () { jump("morn"); });
    $("curve").addEventListener("click", function (ev) {
      var svg = this, r = svg.getBoundingClientRect(), w = r.width, padL = 54, padR = 20;
      var t = N.lo + (ev.clientX - r.left - padL) / (w - padL - padR) * (N.hi - N.lo);
      S.t = Math.round(clamp(t, N.lo, N.hi)); $("time").value = S.t; physicsChanged();
    });

    // drag, wheel and pinch on the sky
    var wrap = $("skywrap"), ptrs = {}, pinch0 = null;
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

  function latHint() {
    $("latNS").textContent = "\u00B0 " + (S.lat >= 0 ? "N" : "S") + (S.lat < 0 ? " (" + Math.abs(S.lat) + "\u00B0 south)" : "");
  }
  function resize() {
    var r = $("skywrap").getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(1, Math.round(r.width * dpr)); H = Math.max(1, Math.round(r.height * dpr));
    canvas.width = W; canvas.height = H; overlay.width = W; overlay.height = H;
    makeFBO(); dirty = true; if (R) updatePanels();
  }

  // ------------------------------------------------------------- go
  initGL();
  bindControls();
  resize();
  N = computeNight();
  S.t = clamp(S.t, N.lo, N.hi);
  $("time").min = N.lo; $("time").max = N.hi; $("time").value = S.t;
  evaluateNow(); needEval = false;
  // On a tall portrait screen the default tilt spends a third of the frame on
  // ground. Tilt up so the horizon sits near the bottom edge instead.
  if (!elFromHash && H > W) {
    var vHalf = Math.atan(Math.tan(S.fov * DEG / 2) * H / W) / DEG;
    S.el = clamp(vHalf - 12, 25, 60);
  }
  if (autoAim) {
    var az = P.ringAzimuth(R.e.hist[S.model], S.fov);
    if (az !== null) S.az = az;
  }
  updatePanels(); updateTimeReadout();
  startCurve();
  writeHash();
  requestAnimationFrame(tick);
  window.__odc = { S: S, get R() { return R; }, get curve() { return curve; }, floatOK: function () { return floatOK; } };
})();

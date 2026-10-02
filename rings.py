"""
Orbital rings: the Python reference for docs/rings.js.

A ring is a megastructure in the sense of Paul Birch's orbital rings: one
continuous band circling the Earth, a circle of radius R_E + alt with a width
and an albedo, in a plane set by an inclination and the right ascension of its
ascending node. This module computes what an observer on the ground sees of it,
using the same pieces the satellite counts use:

    lsm.observer, lsm.sun_dir     geometry, in the frame that turns with the Sun
    lsm.sunlit's cylindrical umbra Earth's shadow
    lsm.airmass, lsm.K_EXT         extinction
    skymodel.brightness            twilight sky over the dome, with skyglow
    twilight.limiting_mag          naked-eye limit against that sky

Each piece of ring is a Lambertian reflector, Boley, Lawler & Rein (2026)
eq 2 with zeta = albedo x length x width. A ring counts as visible where a
patch about one arcminute long (and at most one arcminute wide) beats the
naked-eye limit against the local sky. The ring's plane is fixed against the
stars, and the J2 node drift is applied as a rotation about the pole. The
docstrings in docs/rings.js give the reasoning for each choice; the two
files implement the same model and validate_rings.py checks they agree.

    python3 rings.py      # prints a few example cases
"""

import numpy as np

import lsm as L
import skymodel as SK
import solar
import twilight as T

DEG = L.DEG
R_E = L.R_E
EYE = DEG / 60.0  # naked-eye resolution, 1 arcminute
MIN_SIN_BETA = 0.05  # cap the along-the-line pile-up
FINE_SPACING, COARSE_SPACING = 0.025 * DEG, 0.25 * DEG
MIN_SAMPLES, MAX_SAMPLES = 3600, 600000
# Elevator cables: from CABLE_FOOT km up to the ring, every CABLE_STEP km.
CABLE_FOOT, CABLE_STEP, CABLE_STEP_COARSE = 0.5, 0.25, 5.0
CABLE_MIN, CABLE_MAX = 200, 8000

# fix: 0 star-fixed, 1 ground-fixed (Birch). lon: ground-fixed node, degrees
# east of the observer. stations, stSize (m) and cable (thickness, m; 0 for
# none) apply to ground-fixed rings only. See docs/rings.js.
LIMITS = dict(
    alt=(100.0, 40000.0),
    inc=(0.0, 180.0),
    raan=(0.0, 360.0),
    width=(0.1, 100000.0),
    albedo=(0.01, 1.0),
    fix=(0.0, 1.0),
    lon=(-180.0, 180.0),
    stations=(0.0, 24.0),
    stSize=(1.0, 20000.0),
    cable=(0.0, 1000.0),
)
INTEGER = ("fix", "stations")
DEFAULTS = dict(fix=0.0, lon=0.0, stations=0.0, stSize=500.0, cable=2.0)


def sanitize(spec):
    """Clamp a ring spec to LIMITS, as docs/rings.js sanitize() does."""
    out = {}
    for k, (lo, hi) in LIMITS.items():
        raw = spec.get(k)
        try:
            v = float(raw)
        except (TypeError, ValueError):
            v = float("nan")
        if (raw is None or raw == "" or not np.isfinite(v)) and k in DEFAULTS:
            v = DEFAULTS[k]
        v = float(np.clip(v, lo, hi)) if np.isfinite(v) else lo
        # JavaScript Math.round, not Python's round-half-to-even
        out[k] = float(np.floor(v + 0.5)) if k in INTEGER else v
    return out


def build(spec, ra_sun_hr, coarse=False):
    """
    Sample one ring, and for a ground-fixed ring its stations and cables.
    Star-fixed: node at longitude RAAN - RA_sun in the Sun-fixed frame.
    Ground-fixed: node at `lon`, turned to the observer by node_offset.
    """
    sp = sanitize(spec)
    a = R_E + sp["alt"]
    spacing = COARSE_SPACING if coarse else FINE_SPACING
    n = int(
        round(
            np.clip(
                np.ceil(2 * np.pi * a / (sp["alt"] * spacing)), MIN_SAMPLES, MAX_SAMPLES
            )
        )
    )
    lam = (sp["lon"] if sp["fix"] else sp["raan"] - 15.0 * ra_sun_hr) * DEG
    inc = sp["inc"] * DEG
    node = np.array([np.cos(lam), np.sin(lam), 0.0])
    zxn = np.array([-node[1], node[0], 0.0])
    h = np.array([np.sin(inc) * zxn[0], np.sin(inc) * zxn[1], np.cos(inc)])
    m = np.cross(h, node)
    th = 2 * np.pi * np.arange(n) / n
    c, s = np.cos(th)[:, None], np.sin(th)[:, None]

    ns = int(sp["stations"]) if sp["fix"] else 0
    tq = 2 * np.pi * np.arange(ns) / ns if ns else np.zeros(0)
    u = np.cos(tq)[:, None] * node + np.sin(tq)[:, None] * m  # station directions
    step = CABLE_STEP_COARSE if coarse else CABLE_STEP
    nc = 0
    if ns and sp["cable"] > 0:
        nc = int(
            round(
                np.clip(np.ceil((sp["alt"] - CABLE_FOOT) / step), CABLE_MIN, CABLE_MAX)
            )
        )
    cds = (sp["alt"] - CABLE_FOOT) / nc if nc else 0.0
    radii = R_E + CABLE_FOOT + (np.arange(nc) + 0.5) * cds
    cpos = (u[:, None, :] * radii[None, :, None]).reshape(-1, 3)
    ctan = np.repeat(u, nc, axis=0)
    return dict(
        spec=sp,
        a=a,
        n=n,
        ds=2 * np.pi * a / n,
        pos=a * (c * node + s * m),
        tan=-s * node + c * m,
        stations=a * u,
        cable=dict(n=ns * nc, per_cable=nc, ds=cds, pos=cpos, tan=ctan),
    )


def node_rate(spec):
    """J2 node drift, degrees per day, for material at orbital speed."""
    sp = sanitize(spec)
    a = R_E + sp["alt"]
    n = np.sqrt(L.MU / a**3)
    return float(
        -1.5 * n * L.J2 * (R_E / a) ** 2 * np.cos(sp["inc"] * DEG) * 86400.0 / DEG
    )


def node_shift(spec, date, lst_hr, epoch):
    """Node drift, degrees, from noon on epoch to lst_hr on date (y, m, d)."""
    days = (
        solar._days_since_j2000(*date)
        + (lst_hr - 12.0) / 24.0
        - solar._days_since_j2000(*epoch)
    )
    return node_rate(spec) * days


def node_offset(spec, date, lst_hr, epoch, prec):
    """
    Rotation about the pole to pass to evaluate as d_node, degrees.
    Ground-fixed: turn with the Earth (driven, so J2 does not apply).
    Star-fixed: the J2 drift if prec.
    """
    sp = sanitize(spec)
    if sp["fix"]:
        return (lst_hr - 12.0) * 15.0
    return node_shift(sp, date, lst_hr, epoch) if prec else 0.0


def _rot_z(v, ang):
    c, s = np.cos(ang), np.sin(ang)
    return np.array([c * v[0] - s * v[1], s * v[0] + c * v[1], v[2]])


def piece_mag(albedo, L_m, w_m, d_km, phi, X):
    """Boley et al. eq 2 for a piece L_m by w_m metres."""
    g = (np.pi - phi) * np.cos(phi) + np.sin(phi)
    inner = (2.0 * albedo * L_m * w_m / (3.0 * np.pi**2)) * g
    return (
        L.V_SUN
        - 2.5 * np.log10(np.maximum(inner, 1e-300))
        + 5.0 * np.log10(d_km * 1e3)
        + L.K_EXT * X
    )


def _sky_limit(alt, az, frame, sqm_art):
    """Naked-eye limit against the local sky at each (alt, az)."""
    r_obs, up, east, north, s = frame
    sun_el = float(np.degrees(np.arcsin(np.clip(s @ up, -1, 1))))
    sun_az = float(np.arctan2(s @ east, s @ north))
    saved = SK.SQM_ART
    try:
        SK.SQM_ART = sqm_art
        sky, _ = SK.brightness(alt, az, sun_el, sun_az)
    finally:
        SK.SQM_ART = saved
    return T.limiting_mag(sky)


def _scan_line(P, Tn, ds, w, albedo, frame, sqm_art):
    """Arcs (deg) above the horizon, lit and visible, and the best patch."""
    r_obs, up, east, north, s = frame
    rel = P - r_obs
    above = rel @ up > 0
    P, Tn, rel = P[above], Tn[above], rel[above]
    d = np.linalg.norm(rel, axis=1)
    v = rel / d[:, None]
    sin_beta = np.maximum(np.linalg.norm(np.cross(v, Tn), axis=1), MIN_SIN_BETA)
    ang = ds * sin_beta / d / DEG
    lit = L.sunlit(P, s)
    alt = np.arcsin(np.clip(v @ up, -1, 1))
    az = np.arctan2(v @ east, v @ north)
    phi = np.arccos(np.clip(-(v @ s), -1, 1))
    X = L.airmass(alt)
    L_eye = d * 1e3 * EYE / sin_beta
    w_eye = np.minimum(w, d * 1e3 * EYE)
    V_eye = piece_mag(albedo, L_eye, w_eye, d, phi, X)
    vis = lit & (V_eye < _sky_limit(alt, az, frame, sqm_art))
    return dict(
        up=float(ang.sum()),
        lit=float(ang[lit].sum()),
        visible=float(ang[vis].sum()),
        best=float(V_eye[vis].min()) if vis.any() else None,
    )


def evaluate(ring, lat, lst, dec, sqm_art=None, d_node=0.0):
    """
    One ring at one instant: arcs on the sky in degrees (up, lit, visible),
    the brightest visible one-arcminute patch (best, or None), the same for
    the elevator cables (cable), and station counts (stations: total, up,
    lit, visible) with the brightest visible station (station_best).
    Same definitions as docs/rings.js evaluate().
    """
    r_obs, up, east, north = L.observer(lat, lst)
    s = L.sun_dir(dec)
    if d_node:
        ang = -d_node * DEG
        r_obs, up, east, north, s = (
            _rot_z(v, ang) for v in (r_obs, up, east, north, s)
        )
    frame = (r_obs, up, east, north, s)
    sp = ring["spec"]
    out = _scan_line(
        ring["pos"], ring["tan"], ring["ds"], sp["width"], sp["albedo"], frame, sqm_art
    )
    C = ring["cable"]
    out["cable"] = (
        _scan_line(
            C["pos"], C["tan"], C["ds"], sp["cable"], sp["albedo"], frame, sqm_art
        )
        if C["n"]
        else dict(up=0.0, lit=0.0, visible=0.0, best=None)
    )

    St = ring["stations"]
    st = dict(total=len(St), up=0, lit=0, visible=0)
    best = None
    if len(St):
        rel = St - r_obs
        d = np.linalg.norm(rel, axis=1)
        v = rel / d[:, None]
        above = v @ up > 0
        lit = above & L.sunlit(St, s)
        alt = np.arcsin(np.clip(v @ up, -1, 1))
        az = np.arctan2(v @ east, v @ north)
        phi = np.arccos(np.clip(-(v @ s), -1, 1))
        V = piece_mag(sp["albedo"], sp["stSize"], sp["stSize"], d, phi, L.airmass(alt))
        vis = lit & (V < _sky_limit(alt, az, frame, sqm_art))
        st.update(up=int(above.sum()), lit=int(lit.sum()), visible=int(vis.sum()))
        best = float(V[vis].min()) if vis.any() else None
    out.update(
        stations=st,
        station_best=best,
        sun_el=float(np.degrees(np.arcsin(np.clip(s @ up, -1, 1)))),
    )
    return out


def equatorial_max_lat(alt_km):
    """Highest latitude from which an equatorial ring rises at all, degrees."""
    return float(np.degrees(np.arccos(R_E / (R_E + alt_km))))


if __name__ == "__main__":
    dec, ra = solar.sun(2026, 9, 22)
    lst = solar.sunset_lst(20.0, dec) + 2.0
    print("Latitude 20 N, 22 Sep 2026, 2 h after sunset, dark site\n")
    print("%-28s %8s %8s %8s %8s" % ("ring", "up", "lit", "visible", "best"))
    for spec in (
        dict(alt=1000, inc=0),
        dict(alt=3000, inc=0),
        dict(alt=2000, inc=45),
        dict(alt=3000, inc=0, width=1),
        dict(alt=500, inc=0),
    ):
        spec = dict(dict(raan=0, width=100, albedo=0.2), **spec)
        r = evaluate(build(spec, ra), 20.0, lst, dec)
        name = "%g km, i %g, w %g m" % (spec["alt"], spec["inc"], spec["width"])
        print(
            "%-28s %7.1f° %7.1f° %7.1f° %8s"
            % (
                name,
                r["up"],
                r["lit"],
                r["visible"],
                "-" if r["best"] is None else "%.2f" % r["best"],
            )
        )
    print(
        "\nequatorial cutoff latitude: "
        + ", ".join(
            "%g km %.1f°" % (a, equatorial_max_lat(a)) for a in (300, 2000, 7500)
        )
    )

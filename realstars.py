"""
A real naked-eye star field, from the HYG database (Hipparcos + Yale + Gliese).

8,913 stars brighter than V = 6.5 with true J2000 positions, V magnitudes and
B-V colour. Replaces the synthetic field in stars.py, which had the correct
magnitude distribution but random positions and a fabricated Milky Way.

Local sidereal time is derived from the local solar time and the Sun's right
ascension, so the date enters through RA_SUN:

    March equinox      RA_sun =  0 h
    September equinox  RA_sun = 12 h

Catalogue: HYG v3, astronexus/HYG-Database, CC BY-SA. Sun removed.
"""

import os
import numpy as np

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "hyg_naked_eye.npz")
DEG = np.pi / 180.0


def load():
    d = np.load(DATA)
    ra, dec, mag, ci = d["ra"], d["dec"], d["mag"], d["ci"]
    keep = mag > -20                      # drop the Sun
    return (ra[keep].astype(float), dec[keep].astype(float),
            mag[keep].astype(float), ci[keep].astype(float))


def lst_hours(local_solar_hr, ra_sun_hr):
    return (ra_sun_hr + local_solar_hr - 12.0) % 24.0


def altaz(ra_hr, dec_deg, lst_hr, lat_deg):
    """Equatorial to horizontal. Azimuth measured from north through east."""
    ha = (lst_hr - ra_hr) * 15.0 * DEG
    d = dec_deg * DEG
    lat = lat_deg * DEG
    sin_alt = np.sin(d) * np.sin(lat) + np.cos(d) * np.cos(lat) * np.cos(ha)
    alt = np.arcsin(np.clip(sin_alt, -1, 1))
    az = np.arctan2(-np.cos(d) * np.sin(ha),
                    np.sin(d) * np.cos(lat) - np.cos(d) * np.sin(lat) * np.cos(ha))
    return alt, az % (2 * np.pi)


def bv_to_rgb(ci):
    """Crude but monotonic B-V to display colour. Blue-white through orange."""
    t = np.clip((ci + 0.4) / 2.0, 0.0, 1.0)[:, None]
    cold = np.array([0.72, 0.80, 1.00])
    warm = np.array([1.00, 0.78, 0.60])
    return cold * (1 - t) + warm * t


def sky(local_solar_hr, ra_sun_hr=0.0, lat_deg=37.23):
    ra, dec, mag, ci = load()
    alt, az = altaz(ra, dec, lst_hours(local_solar_hr, ra_sun_hr), lat_deg)
    return alt, az, mag, bv_to_rgb(ci)


if __name__ == "__main__":
    import csv
    ra, dec, mag, ci = load()
    print("%d stars, V %.2f to %.2f\n" % (len(mag), mag.min(), mag.max()))
    names = {}
    with open("/tmp/cat/hygdata_v3.csv") as f:
        for r in csv.DictReader(f):
            if r["proper"]:
                try:
                    names[(round(float(r["ra"]), 4), round(float(r["dec"]), 4))] = \
                        (r["proper"], r["con"])
                except Exception:
                    pass
    LST_HR = 19.0 + 20.0 / 60.0                      # 80 min after an 18:00 sunset
    for ra_sun, lab in ((0.0, "March equinox"), (12.0, "September equinox")):
        alt, az = altaz(ra, dec, lst_hours(LST_HR, ra_sun), 37.23)
        daz = (np.degrees(az) - 315.0 + 180) % 360 - 180
        inframe = (np.abs(daz) < 47.5) & (alt > np.radians(3))
        idx = np.argsort(mag[inframe])[:10]
        sel = np.nonzero(inframe)[0][idx]
        print("%s, looking NW (315 deg), LST %.1f h: %d stars in frame"
              % (lab, lst_hours(LST_HR, ra_sun), inframe.sum()))
        for i in sel:
            nm, cn = names.get((round(ra[i], 4), round(dec[i], 4)), ("", ""))
            print("    V %5.2f  alt %4.1f  az %5.1f   %-14s %s"
                  % (mag[i], np.degrees(alt[i]), np.degrees(az[i]), nm, cn))
        print()

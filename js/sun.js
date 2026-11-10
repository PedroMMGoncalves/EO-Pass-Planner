/**
 * sun.js: solar elevation and azimuth at a point and time.
 *
 * Method: NOAA solar position equations (Meeus, "Astronomical Algorithms",
 * as implemented in the NOAA Solar Calculator spreadsheets), using UTC in
 * place of TT.
 *
 * Inputs:  Date (or ms since epoch), latitude and longitude in degrees.
 * Outputs: { elevation, azimuth } in degrees. Azimuth is clockwise from north.
 *          Elevation is geometric: no atmospheric refraction correction.
 *
 * Limitations: about 0.01° for 1800-2100 (stated NOAA accuracy). The
 * refraction correction is omitted, so elevations near the horizon are about
 * 0.5° lower than apparent. "Daytime" filters at 0° are therefore slightly
 * conservative.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/** Declination (rad) and equation of time (min) at `ms`. */
function solarTerms(ms) {
  const jd = ms / 86400000 + 2440587.5;
  const T = (jd - 2451545) / 36525; // Julian centuries since J2000.0

  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360; // geometric mean longitude
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T); // mean anomaly
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T); // orbital eccentricity
  const C = Math.sin(M * RAD) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * M * RAD) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * M * RAD) * 0.000289; // equation of centre
  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(omega * RAD); // apparent longitude
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(omega * RAD); // corrected obliquity
  const decl = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD));

  const y = Math.tan((eps / 2) * RAD) ** 2;
  const eqTimeMin = 4 * DEG * (
    y * Math.sin(2 * L0 * RAD)
    - 2 * e * Math.sin(M * RAD)
    + 4 * e * y * Math.sin(M * RAD) * Math.cos(2 * L0 * RAD)
    - 0.5 * y * y * Math.sin(4 * L0 * RAD)
    - 1.25 * e * e * Math.sin(2 * M * RAD)
  );

  return { decl, eqTimeMin };
}

const toMs = (time) => (time instanceof Date ? time.getTime() : Number(time));
const utcMinutes = (ms) => (((ms % 86400000) + 86400000) % 86400000) / 60000;

/** Sub-solar point {lat, lon} in degrees (for the day/night terminator). */
export function subsolarPoint(time) {
  const ms = toMs(time);
  const { decl, eqTimeMin } = solarTerms(ms);
  let lon = (720 - utcMinutes(ms) - eqTimeMin) / 4;
  lon = ((lon + 180) % 360 + 360) % 360 - 180;
  return { lat: decl * DEG, lon };
}

export function solarPosition(time, latDeg, lonDeg) {
  const ms = toMs(time);
  const { decl, eqTimeMin } = solarTerms(ms);
  const utcMin = utcMinutes(ms);
  const trueSolarMin = (((utcMin + eqTimeMin + 4 * lonDeg) % 1440) + 1440) % 1440;
  const hourAngle = trueSolarMin / 4 - 180; // degrees, negative before solar noon

  const lat = latDeg * RAD;
  const ha = hourAngle * RAD;
  const cosZen = Math.min(1, Math.max(-1,
    Math.sin(lat) * Math.sin(decl) + Math.cos(lat) * Math.cos(decl) * Math.cos(ha)));
  const zen = Math.acos(cosZen);
  const elevation = 90 - zen * DEG;

  // Azimuth from north, clockwise (atan2 form is stable at the poles and at noon).
  const az = Math.atan2(
    Math.sin(ha),
    Math.cos(ha) * Math.sin(lat) - Math.tan(decl) * Math.cos(lat),
  ) * DEG + 180;
  return { elevation, azimuth: ((az % 360) + 360) % 360 };
}

export const solarElevation = (time, lat, lon) => solarPosition(time, lat, lon).elevation;

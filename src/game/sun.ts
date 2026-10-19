// Where the sun is over a circuit right now: a standard low-precision solar position (good to
// about a degree), used for "Live" time of day. No dependencies, so the home screen can use it.

export interface SunPosition {
  elevation: number; // degrees above the horizon
  azimuth: number; // degrees clockwise from north
}

export function sunPosition(lat: number, lon: number, date = new Date()): SunPosition {
  const rad = Math.PI / 180;
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * rad; // mean anomaly
  const q = 280.459 + 0.98564736 * d; // mean longitude
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * rad; // ecliptic longitude
  const e = (23.439 - 0.00000036 * d) * rad; // obliquity
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = 280.46061837 + 360.98564736629 * d; // sidereal time at Greenwich, degrees
  const H = (gmst + lon) * rad - ra; // hour angle
  const phi = lat * rad;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(phi) - Math.sin(phi) * Math.cos(H));
  return { elevation: el / rad, azimuth: ((az / rad) % 360 + 360) % 360 };
}

/** Night once the sun is 4° below the horizon: kart tracks have their floodlights on by then. */
export function isNightAt(center: [number, number], date = new Date()): boolean {
  return sunPosition(center[0], center[1], date).elevation < -4;
}

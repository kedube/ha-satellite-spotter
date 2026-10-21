/**
 * Magnetic declination, for pointing the street view with a phone's compass.
 * A compass heading is measured from magnetic north, while the sky, the
 * streets and every azimuth here are measured from true north, and the two
 * differ by up to 20 degrees and more where people live (about 14 degrees
 * west in Boston, 15 east in Seattle): true bearing = heading + declination.
 *
 * The field is the World Magnetic Model WMM2025 of NOAA and the British
 * Geological Survey (public domain, https://www.ncei.noaa.gov/products/world-magnetic-model),
 * evaluated as its technical report describes, and checked against its
 * official test values. It is made for 2025.0 to 2030.0; after that its
 * yearly change carries on, which drifts by about a tenth of a degree a year
 * until the next model replaces the coefficients below. Pure functions with
 * no DOM.
 */

const EPOCH = 2025;
const DEG = Math.PI / 180;
// WGS 84 (km), and the model's reference radius.
const WGS84_A_KM = 6378.137;
const WGS84_E2 = 0.00669437999014;
const REFERENCE_RADIUS_KM = 6371.2;

// Gauss coefficients in nT: [g, h, yearly change of g, of h] for each degree
// n = 1..12 and order m = 0..n (WMM.COF of WMM2025, as published).
const COEFFICIENTS = [
  // n = 1
  [-29351.8, 0, 12, 0], [-1410.8, 4545.4, 9.7, -21.5],
  // n = 2
  [-2556.6, 0, -11.6, 0], [2951.1, -3133.6, -5.2, -27.7], [1649.3, -815.1, -8, -12.1],
  // n = 3
  [1361, 0, -1.3, 0], [-2404.1, -56.6, -4.2, 4], [1243.8, 237.5, 0.4, -0.3], [453.6, -549.5, -15.6, -4.1],
  // n = 4
  [895, 0, -1.6, 0], [799.5, 278.6, -2.4, -1.1], [55.7, -133.9, -6, 4.1], [-281.1, 212, 5.6, 1.6],
  [12.1, -375.6, -7, -4.4],
  // n = 5
  [-233.2, 0, 0.6, 0], [368.9, 45.4, 1.4, -0.5], [187.2, 220.2, 0, 2.2], [-138.7, -122.9, 0.6, 0.4],
  [-142, 43, 2.2, 1.7], [20.9, 106.1, 0.9, 1.9],
  // n = 6
  [64.4, 0, -0.2, 0], [63.8, -18.4, -0.4, 0.3], [76.9, 16.8, 0.9, -1.6], [-115.7, 48.8, 1.2, -0.4],
  [-40.9, -59.8, -0.9, 0.9], [14.9, 10.9, 0.3, 0.7], [-60.7, 72.7, 0.9, 0.9],
  // n = 7
  [79.5, 0, 0, 0], [-77, -48.9, -0.1, 0.6], [-8.8, -14.4, -0.1, 0.5], [59.3, -1, 0.5, -0.8],
  [15.8, 23.4, -0.1, 0], [2.5, -7.4, -0.8, -1], [-11.1, -25.1, -0.8, 0.6], [14.2, -2.3, 0.8, -0.2],
  // n = 8
  [23.2, 0, -0.1, 0], [10.8, 7.1, 0.2, -0.2], [-17.5, -12.6, 0, 0.5], [2, 11.4, 0.5, -0.4],
  [-21.7, -9.7, -0.1, 0.4], [16.9, 12.7, 0.3, -0.5], [15, 0.7, 0.2, -0.6], [-16.8, -5.2, 0, 0.3],
  [0.9, 3.9, 0.2, 0.2],
  // n = 9
  [4.6, 0, 0, 0], [7.8, -24.8, -0.1, -0.3], [3, 12.2, 0.1, 0.3], [-0.2, 8.3, 0.3, -0.3],
  [-2.5, -3.3, -0.3, 0.3], [-13.1, -5.2, 0, 0.2], [2.4, 7.2, 0.3, -0.1], [8.6, -0.6, -0.1, -0.2],
  [-8.7, 0.8, 0.1, 0.4], [-12.9, 10, -0.1, 0.1],
  // n = 10
  [-1.3, 0, 0.1, 0], [-6.4, 3.3, 0, 0], [0.2, 0, 0.1, 0], [2, 2.4, 0.1, -0.2], [-1, 5.3, 0, 0.1],
  [-0.6, -9.1, -0.3, -0.1], [-0.9, 0.4, 0, 0.1], [1.5, -4.2, -0.1, 0], [0.9, -3.8, -0.1, -0.1],
  [-2.7, 0.9, 0, 0.2], [-3.9, -9.1, 0, 0],
  // n = 11
  [2.9, 0, 0, 0], [-1.5, 0, 0, 0], [-2.5, 2.9, 0, 0.1], [2.4, -0.6, 0, 0], [-0.6, 0.2, 0, 0.1],
  [-0.1, 0.5, -0.1, 0], [-0.6, -0.3, 0, 0], [-0.1, -1.2, 0, 0.1], [1.1, -1.7, -0.1, 0], [-1, -2.9, -0.1, 0],
  [-0.2, -1.8, -0.1, 0], [2.6, -2.3, -0.1, 0],
  // n = 12
  [-2, 0, 0, 0], [-0.2, -1.3, 0, 0], [0.3, 0.7, 0, 0], [1.2, 1, 0, -0.1], [-1.3, -1.4, 0, 0.1], [0.6, 0, 0, 0],
  [0.6, 0.6, 0.1, 0], [0.5, -0.1, 0, 0], [-0.1, 0.8, 0, 0], [-0.4, 0.1, 0, 0], [-0.2, -1, -0.1, 0],
  [-1.3, 0.1, 0, 0], [-0.7, 0.2, -0.1, -0.1],
];
const MAX_DEGREE = 12;

/** A date (Date or unix milliseconds) as a decimal year: 2025.5 is the 2nd of July 2025. */
export function decimalYear(date) {
  const ms = +date;
  const year = new Date(ms).getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  return year + (ms - start) / (Date.UTC(year + 1, 0, 1) - start);
}

/**
 * The magnetic field (nT) as its north, east and down components, at a
 * geodetic latitude and longitude (degrees) and a height above the WGS 84
 * ellipsoid (km), in a decimal year.
 */
export function magneticField(latDeg, lonDeg, altKm = 0, year = EPOCH) {
  const dt = year - EPOCH;
  // Geodetic to geocentric spherical coordinates.
  const phi = latDeg * DEG;
  const lambda = lonDeg * DEG;
  const sinPhi = Math.sin(phi);
  const rc = WGS84_A_KM / Math.sqrt(1 - WGS84_E2 * sinPhi * sinPhi);
  const axial = (rc * (1 - WGS84_E2) + altKm) * sinPhi;
  const r = Math.hypot((rc + altKm) * Math.cos(phi), axial);
  const phiC = Math.asin(axial / r);
  const x = Math.sin(phiC);
  const c = Math.cos(phiC);
  // Associated Legendre functions of sin(phiC) and their derivatives with
  // respect to colatitude, Gauss-normalised by recursion, and the factors
  // that make them Schmidt semi-normalised, as the coefficients are.
  const P = [[1]];
  const dP = [[0]];
  const S = [[1]];
  const ratio = REFERENCE_RADIUS_KM / r;
  let radius = ratio * ratio;
  let north = 0;
  let east = 0;
  let down = 0;
  let i = 0;
  for (let n = 1; n <= MAX_DEGREE; n++) {
    P[n] = [];
    dP[n] = [];
    S[n] = [];
    radius *= ratio; // (a / r) ** (n + 2)
    for (let m = 0; m <= n; m++, i++) {
      if (m === n) {
        P[n][m] = c * P[n - 1][m - 1];
        dP[n][m] = c * dP[n - 1][m - 1] + x * P[n - 1][m - 1];
      } else {
        // Degree n - 2 has this order only when m <= n - 2.
        const k = m <= n - 2 ? ((n - 1) ** 2 - m * m) / ((2 * n - 1) * (2 * n - 3)) : 0;
        P[n][m] = x * P[n - 1][m] - (k ? k * P[n - 2][m] : 0);
        dP[n][m] = x * dP[n - 1][m] - c * P[n - 1][m] - (k ? k * dP[n - 2][m] : 0);
      }
      S[n][m] =
        m === 0
          ? (S[n - 1][0] * (2 * n - 1)) / n
          : S[n][m - 1] * Math.sqrt(((n - m + 1) * (m === 1 ? 2 : 1)) / (n + m));
      const [g0, h0, gYear, hYear] = COEFFICIENTS[i];
      const g = g0 + dt * gYear;
      const h = h0 + dt * hYear;
      const cosM = Math.cos(m * lambda);
      const sinM = Math.sin(m * lambda);
      const pnm = P[n][m] * S[n][m];
      const dpnmLat = -dP[n][m] * S[n][m];
      const along = g * cosM + h * sinM;
      north -= radius * along * dpnmLat;
      east += radius * m * (g * sinM - h * cosM) * pnm;
      down -= radius * (n + 1) * along * pnm;
    }
  }
  // Only a point on the axis itself (where the declination means nothing) divides by zero.
  east /= Math.max(c, 1e-12);
  // From the geocentric to the geodetic vertical.
  const psi = phiC - phi;
  return {
    north: north * Math.cos(psi) - down * Math.sin(psi),
    east,
    down: north * Math.sin(psi) + down * Math.cos(psi),
  };
}

/**
 * The declination (degrees, east positive) at a geodetic latitude and
 * longitude, a height above the ellipsoid (km) and a decimal year. The same
 * all day for a place: compute it once rather than for every compass reading.
 */
export function declination(latDeg, lonDeg, altKm = 0, year = decimalYear(Date.now())) {
  const { north, east } = magneticField(latDeg, lonDeg, altKm, year);
  return Math.atan2(east, north) / DEG;
}

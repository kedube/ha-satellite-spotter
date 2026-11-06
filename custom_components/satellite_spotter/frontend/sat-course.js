/**
 * The rows a satellite moves along on the globe, apart from any drawing: its orbit at 30 s, the
 * pass itself at a few seconds, and what to make of the time between them. A row is
 * [t, lat, lon, alt_km, lit, ...]. No DOM, so it can be tested alone.
 *
 * The orbit and a pass hours later live in one array, and the time between them is no road: that is
 * for positionAt (sat-geo.js) to refuse, as it does across any gap in the rows.
 */

/** Rows within [from, to] (unix s), the part of a pass that can be seen. */
export function rowsBetween(rows, from, to) {
  return (rows || []).filter((r) => r[0] >= from - 1 && r[0] <= to + 1);
}

/** One satellite's rows of a pass_track payload, or null if it could not be placed. */
export function transitRows(detail, index) {
  return detail?.transits?.[index]?.rows ?? null;
}

/**
 * Tracks of one satellite merged in time order, finer ones winning where
 * they overlap: the orbit at 30 s, the pass itself at 2 s.
 */
export function mergeRows(...tracks) {
  const parts = tracks.filter((t) => t?.length > 1);
  if (!parts.length) return [];
  if (parts.length === 1) return parts[0];
  // Finest last: it replaces the coarser rows over its own span.
  parts.sort((a, b) => (b[1][0] - b[0][0]) - (a[1][0] - a[0][0]));
  let merged = parts[0];
  for (const fine of parts.slice(1)) {
    const lo = fine[0][0];
    const hi = fine[fine.length - 1][0];
    merged = [...merged.filter((r) => r[0] < lo || r[0] > hi), ...fine].sort((a, b) => a[0] - b[0]);
  }
  return merged;
}

/** Whether rows cover [from, to] without a gap longer than `gap` seconds. */
export function rowsCover(rows, from, to, gap = 300) {
  if (!rows?.length || rows[0][0] > from + gap || rows[rows.length - 1][0] < to - gap) return false;
  for (let i = 1; i < rows.length; i++) if (rows[i][0] - rows[i - 1][0] > gap) return false;
  return true;
}

// How far around now the focus satellite's orbit is asked for, in periods, and how little may be
// left ahead before asking again. The clock ticks along the orbit reach one period ahead, so what is
// left must too, or they would run out over the gap to the pass.
const ORBIT_BEHIND_PERIODS = 0.5;
const ORBIT_AHEAD_PERIODS = 1.5;
const ORBIT_LEFT_PERIODS = 1.05;

/** The stretch of orbit to ask for around now (unix s), given the satellite's period. */
export function orbitSpan(nowS, periodS) {
  return { from: Math.floor(nowS - ORBIT_BEHIND_PERIODS * periodS), to: Math.ceil(nowS + ORBIT_AHEAD_PERIODS * periodS) };
}

/** Whether the orbit there is still enough, for that satellite. */
export function orbitIsEnough(have, noradId, nowS, periodS) {
  return have?.norad === noradId && have.from <= nowS && have.to >= nowS + ORBIT_LEFT_PERIODS * periodS;
}

/** The rows a focus satellite moves along live: its orbit, and its rows of the pass on show. */
export function courseOf(orbit, detail, noradId) {
  const index = detail ? detail.transits.findIndex((t) => t.norad_id === noradId) : -1;
  return mergeRows(orbit, index >= 0 ? transitRows(detail, index) : null);
}

/** The times of the clock ticks along the orbit ahead (unix s), up to a period on and while there are rows. */
export function tickTimes(rows, nowS, periodS, stepS) {
  if (!rows.length) return [];
  const last = Math.min(nowS + periodS, rows[rows.length - 1][0]);
  const times = [];
  for (let t = Math.ceil((nowS + 120) / stepS) * stepS; t <= last; t += stepS) times.push(t);
  return times;
}

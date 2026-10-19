// Relative time in the style of dayjs' relativeTime plugin ("in a month", "15 days ago").
const THRESHOLDS = [
  { l: 's', r: 44, d: 'second' },
  { l: 'm', r: 89 },
  { l: 'mm', r: 44, d: 'minute' },
  { l: 'h', r: 89 },
  { l: 'hh', r: 21, d: 'hour' },
  { l: 'd', r: 35 },
  { l: 'dd', r: 25, d: 'day' },
  { l: 'M', r: 45 },
  { l: 'MM', r: 10, d: 'month' },
  { l: 'y', r: 17 },
  { l: 'yy', d: 'year' },
];
const FORMATS = {
  s: 'a few seconds', m: 'a minute', mm: '%d minutes', h: 'an hour', hh: '%d hours',
  d: 'a day', dd: '%d days', M: 'a month', MM: '%d months', y: 'a year', yy: '%d years',
};

// Fractional number of months from `from` to `to` (same algorithm as dayjs' monthDiff).
function monthDiff(to, from) {
  const whole = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  const anchor = addMonths(from, whole);
  const before = to - anchor < 0;
  const anchor2 = addMonths(from, whole + (before ? -1 : 1));
  return whole + (to - anchor) / Math.abs(anchor2 - anchor) || 0;
}

function addMonths(date, n) {
  const d = new Date(date.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function diffIn(unit, target, now) {
  const ms = target - now;
  switch (unit) {
    case 'second': return ms / 1000;
    case 'minute': return ms / 60000;
    case 'hour': return ms / 3600000;
    case 'day': return ms / 86400000;
    case 'month': return monthDiff(target, now);
    case 'year': return monthDiff(target, now) / 12;
    default: return 0;
  }
}

export function fromNow(target, now = new Date()) {
  let result = 0;
  let out = '';
  for (let i = 0; i < THRESHOLDS.length; i += 1) {
    let t = THRESHOLDS[i];
    if (t.d) result = diffIn(t.d, target, now);
    const abs = Math.round(Math.abs(result));
    if (abs <= t.r || !t.r) {
      if (abs <= 1 && i > 0) t = THRESHOLDS[i - 1];
      out = FORMATS[t.l].replace('%d', abs);
      break;
    }
  }
  return result > 0 ? `in ${out}` : `${out} ago`;
}

export function relativeDue(date) {
  return `Due ${fromNow(date)}`;
}

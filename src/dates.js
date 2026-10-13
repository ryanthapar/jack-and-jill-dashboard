// Weeks run Monday–Sunday. All dates are 'YYYY-MM-DD' strings handled in UTC
// so server timezone never shifts a day.
const RE = /^\d{4}-\d{2}-\d{2}$/;

function isDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function addDays(s, n) {
  const d = new Date(s + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function weekStart(s) {
  const dow = (new Date(s + 'T00:00:00Z').getUTCDay() + 6) % 7; // Mon=0
  return addDays(s, -dow);
}
function weekDays(start) {
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}
const todayUTC = () => new Date().toISOString().slice(0, 10);

module.exports = { isDate, addDays, weekStart, weekDays, todayUTC };

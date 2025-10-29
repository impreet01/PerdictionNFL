// trainer/utils/temporalWindow.js
export function isBefore(target, row) {
  const ts = Number(target.season);
  const tw = Number(target.week);
  const rs = Number(row.season);
  const rw = Number(row.week);
  return (rs < ts) || (rs === ts && rw < tw);
}

export function sortChronologically(rows) {
  return [...rows].sort((a, b) => {
    const sa = Number(a.season), sb = Number(b.season);
    if (sa !== sb) return sa - sb;
    return Number(a.week) - Number(b.week);
  });
}

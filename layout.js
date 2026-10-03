/* Pure geometry helpers (no Electron imports) so they can be unit-tested with plain node. */

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function inflate(r, m) {
  return { x: r.x - m, y: r.y - m, width: r.width + 2 * m, height: r.height + 2 * m };
}

/**
 * Decide which side of the icon the panel opens on and where it goes.
 * icon: {x,y,w,h} screen rect of the visible icon; wa: work area {x,y,width,height}.
 * Horizontal placement (left/right) is preferred; then up/down; if nothing fits
 * the roomiest side is used and the panel is shrunk to fit.
 */
function computeLayout({ icon, wa, pw, ph, gap = 10, edge = 8 }) {
  const L = icon.x - gap - (wa.x + edge);
  const R = wa.x + wa.width - edge - (icon.x + icon.w + gap);
  const U = icon.y - gap - (wa.y + edge);
  const D = wa.y + wa.height - edge - (icon.y + icon.h + gap);

  pw = Math.min(pw, wa.width - 2 * edge);
  ph = Math.min(ph, wa.height - 2 * edge);

  const roomiest = (list) => list.sort((a, b) => b[1] - a[1])[0][0];
  const h = [], v = [];
  if (L >= pw) h.push(['left', L]);
  if (R >= pw) h.push(['right', R]);
  if (U >= ph) v.push(['up', U]);
  if (D >= ph) v.push(['down', D]);

  let dir;
  if (h.length) dir = roomiest(h);
  else if (v.length) dir = roomiest(v);
  else {
    const all = [['left', L], ['right', R], ['up', U], ['down', D]];
    dir = roomiest(all);
    const space = { left: L, right: R, up: U, down: D }[dir];
    if (dir === 'left' || dir === 'right') pw = Math.max(180, Math.min(pw, space));
    else ph = Math.max(140, Math.min(ph, space));
  }

  let x, y;
  if (dir === 'left' || dir === 'right') {
    x = dir === 'left' ? icon.x - gap - pw : icon.x + icon.w + gap;
    y = clamp(icon.y, wa.y + edge, wa.y + wa.height - edge - ph); // align tops, stay on screen
  } else {
    y = dir === 'up' ? icon.y - gap - ph : icon.y + icon.h + gap;
    x = clamp(icon.x + icon.w / 2 - pw / 2, wa.x + edge, wa.x + wa.width - edge - pw); // centre on icon
  }

  const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(pw), height: Math.round(ph) };
  const origin = { x: icon.x + icon.w / 2 - rect.x, y: icon.y + icon.h / 2 - rect.y };
  return { dir, rect, origin };
}

/* The edge of the panel that touches the icon stays fixed when the panel is resized. */
function anchoredRect(dir, rect, w, h) {
  if (dir === 'left') return { x: rect.x + rect.width - w, y: rect.y, width: w, height: h };
  if (dir === 'up') return { x: rect.x, y: rect.y + rect.height - h, width: w, height: h };
  return { x: rect.x, y: rect.y, width: w, height: h };
}

function maxSizes(dir, rect, wa, edge, cap) {
  const right = rect.x + rect.width;
  const bottom = rect.y + rect.height;
  const maxW = dir === 'left' ? right - (wa.x + edge) : wa.x + wa.width - edge - rect.x;
  const maxH = dir === 'up' ? bottom - (wa.y + edge) : wa.y + wa.height - edge - rect.y;
  return {
    maxW: Math.max(rect.width, Math.min(maxW, cap.w)),
    maxH: Math.max(rect.height, Math.min(maxH, cap.h))
  };
}

module.exports = { clamp, inflate, computeLayout, anchoredRect, maxSizes };

import qrcode from 'qrcode-generator';

/**
 * Turns a payment link into a QR code, as inline SVG.
 *
 * WHY SVG. The same invoice gets printed on A4 at 300 dpi and on a 2-inch thermal roll at 203 dpi. A raster QR has
 * to pick a pixel size in advance and is then either soft on paper or enormous in the file; a vector one is exact at
 * every size, and `shape-rendering="crispEdges"` keeps the module edges on whole pixels so a cheap thermal head
 * still prints squares rather than grey smudges. It also costs nothing: the markup is a few hundred bytes of path
 * data, inline in the document, with no image request to fail at print time.
 *
 * WHY ERROR CORRECTION LEVEL M. A printed invoice gets folded, stamped and handled; level M recovers from about 15%
 * damage, which covers a crease through the code. Level H would survive more but makes the code denser, and density
 * is the enemy on thermal paper.
 *
 * THE LIBRARY IS BEHIND THIS FILE. `qrcode-generator` is imported here and nowhere else, and this module hands back
 * a plain string, so swapping the encoder later means rewriting one function and no call sites.
 */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * The QR for a payment URI, or `null` when there is nothing to encode.
 *
 * `null` in, `null` out — deliberately. `upiPaymentUri()` returns null whenever a QR would be wrong (no UPI ID, a
 * credit note, a zero amount), and this passes that straight through, so the print template has one thing to check
 * rather than two.
 *
 * @param {string|null} uri      the payment link, from `upiPaymentUri()`
 * @param {object}      options  `margin` in modules (the quiet zone a scanner needs), `title` for screen readers
 * @returns {string|null} an `<svg>` element as a string, ready to inline
 */
export function upiQrSvg(uri, { margin = 2, title = 'Scan to pay by UPI' } = {}) {
  const data = String(uri || '').trim();
  if (!data) return null;

  // Type 0 lets the library pick the smallest version that fits the data; 'M' is the error-correction level.
  const qr = qrcode(0, 'M');
  qr.addData(data);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = Math.max(0, Math.trunc(margin));
  const size = count + quiet * 2;

  // One path for every dark module. Runs of adjacent modules are merged into a single rectangle, which roughly
  // halves the markup and gives the printer fewer, longer edges to render.
  let d = '';
  for (let row = 0; row < count; row += 1) {
    let col = 0;
    while (col < count) {
      if (!qr.isDark(row, col)) {
        col += 1;
        continue;
      }
      let run = 1;
      while (col + run < count && qr.isDark(row, col + run)) run += 1;
      d += `M${col + quiet} ${row + quiet}h${run}v1h-${run}z`;
      col += run;
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="100%" height="100%" ` +
    `shape-rendering="crispEdges" role="img" aria-label="${esc(title)}">` +
    `<title>${esc(title)}</title>` +
    // The quiet zone must be white, not transparent: a QR printed onto a tinted invoice background will not scan.
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path d="${d}" fill="#000000"/>` +
    '</svg>'
  );
}

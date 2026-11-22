/*
 * The source image for the zoom.
 *
 * This is a real photograph (stock imagery of a pharmacy counter, supplied for this build) rather than the drawn
 * stand-in this scene started with. It is never captioned as a particular pharmacy, and the batch/expiry text the
 * HUD prints over it is sample data, not read from the picture.
 *
 * The contract the rest of the scene depends on is unchanged: SRC_W/SRC_H are the image's natural size, and
 * TARGET is the point the camera pushes in to — the centre of the barcode, in SOURCE PIXELS. To swap the photo,
 * replace the file, update these three constants, and nothing else has to change.
 */

const URL = '/landing/counter.jpg';

export const SRC_W = 2752;
export const SRC_H = 1536;

/** Centre of the barcode on the strip being handed across the counter, measured in the 2752x1536 original. */
export const TARGET = { x: 1580, y: 878 };

let img = null;
let pending = null;

/** Starts (or joins) the load. Resolves with the image, or null if it could not be decoded. */
export function loadSource() {
  if (img) return Promise.resolve(img);
  if (!pending) {
    pending = new Promise((resolve) => {
      const el = new Image();
      el.decoding = 'async';
      el.src = URL;
      el.onload = () => {
        img = el;
        resolve(el);
      };
      el.onerror = () => resolve(null); // the canvas falls back to a flat fill
    });
  }
  return pending;
}

/** The image if it has already loaded, otherwise null. Safe to call every frame. */
export function getSource() {
  return img;
}

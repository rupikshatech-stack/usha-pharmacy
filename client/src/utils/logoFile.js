/**
 * Whether a chosen file can be a store logo.
 *
 * The server checks the real bytes again and is the authority; this only saves a round trip and gives the person
 * an answer while they are still looking at the file picker.
 *
 * SVG is called out by name rather than falling into "unsupported type", because somebody choosing a logo almost
 * certainly HAS an SVG and deserves to know why it is refused and what to do instead.
 */
export const LOGO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const LOGO_MAX_MB = 2;

export function logoProblem(file, maxMB = LOGO_MAX_MB) {
  if (!file) return 'Choose an image';
  if (/\.svg$/i.test(file.name || '') || file.type === 'image/svg+xml') {
    return 'SVG cannot be used as a logo: an SVG can carry script. Export it as a PNG and upload that.';
  }
  if (!LOGO_TYPES.includes(file.type) && !/\.(jpe?g|png|webp)$/i.test(file.name || '')) return 'Use a JPG, PNG or WEBP image';
  if (file.type && !LOGO_TYPES.includes(file.type)) return 'Use a JPG, PNG or WEBP image';
  if (!file.size) return 'That file is empty';
  if (file.size > maxMB * 1048576) return `Use a file up to ${maxMB} MB`;
  return '';
}

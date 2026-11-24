/*
 * Formulation presets as PLAIN DATA — no three.js import.
 *
 * Kept free of dependencies so anything outside the scene can read the colours without pulling three's bundle
 * (~520 KB) into the main chunk, which the counter app would then download. `capsule.js`, which does import three,
 * re-exports these.
 */
export const PRESETS = {
  emerald: { label: 'Glycomet SR 500', cap: 0x175943, body: 0xf4f0e6, pellets: [0x2a8566, 0xc77d3b, 0x175943], ring: 0xb59c72 },
  cobalt: { label: 'Atorva Dual-20', cap: 0x1e4363, body: 0xf2eee4, pellets: [0x3d7aa8, 0x8fb8d6, 0x1e4363], ring: 0x9aa9b8 },
  amber: { label: 'Uprise-D3 Amber', cap: 0xb66a26, body: 0xe6b468, pellets: [0xd9923b, 0xf5cf86, 0x9e5316], ring: 0xc2a374 },
};

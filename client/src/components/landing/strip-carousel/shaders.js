/*
 * The bend happens per-vertex, not per-card: every vertex works out its own position along the arc from its
 * local x, so a card near the edge genuinely curves instead of staying a flat quad that has been rotated.
 *
 * The fragment stage adds the two things that sell it: a soft edge so cards fade out rather than ending on a
 * hard line, and a small red/blue sample offset that grows with the curl, reading as chromatic smear.
 */

export const VERT = `#version 300 es
precision highp float;

in vec2 aPos;          // -0.5..0.5 quad
out vec2 vUv;
out float vCurl;

uniform float uP;      // this card's signed track position
uniform float uSpan;   // card width in slot units
uniform float uAspect; // viewport aspect
uniform float uScale;  // fit-to-stage scale
uniform float uCardH;
uniform float uRadius; // set per viewport by warp.js; see radiusFor()

const float RADIUS_UNUSED = 0.0;
const float BEND   = 1.15;
const float CURL   = 0.55;

void place(float p, out vec3 pos, out float ry) {
  float over = max(0.0, abs(p) - 1.0) * sign(p);
  float a = p * BEND + over * CURL;
  pos = vec3(sin(a) * uRadius, 0.0, (cos(a) - 1.0) * uRadius);
  ry = -a;
}

void main() {
  // canvas 2D rows run top-down, clip space runs bottom-up, so V is flipped here
  vUv = vec2(aPos.x + 0.5, 0.5 - aPos.y);

  // each vertex sits at its own point on the arc
  float p = uP + aPos.x * uSpan;
  vec3 base; float ry;
  place(p, base, ry);

  // how hard this vertex is curling, used for the smear and the edge fade
  vCurl = clamp(abs(p) - 0.45, 0.0, 1.6);

  vec3 pos = base;
  pos.y += aPos.y * uCardH * 2.0;

  // things further round the arc sit further back and shrink
  float persp = 1.0 / (1.0 - pos.z * 0.26);
  vec2 world = vec2(pos.x, pos.y) * persp * uScale;

  // the stage is y in [-1,1]; x is divided by the aspect to stay square
  gl_Position = vec4(world.x / uAspect, world.y, 0.0, 1.0);
}`;

export const FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in float vCurl;
out vec4 outColor;

uniform sampler2D uTex;
uniform float uAlpha;
uniform float uSmear;

void main() {
  // red/blue split grows with the curl, so only the bent edges smear
  float d = uSmear * vCurl * 0.008;
  vec2 off = vec2(d, 0.0);

  float r = texture(uTex, vUv + off).r;
  vec4  c = texture(uTex, vUv);
  float b = texture(uTex, vUv - off).b;

  // soft edge instead of a hard cut
  vec2 e = smoothstep(vec2(0.0), vec2(0.035), vUv)
         * smoothstep(vec2(0.0), vec2(0.035), vec2(1.0) - vUv);
  float edge = e.x * e.y;

  // the further a card has curled, the more it recedes into the page
  float fade = 1.0 - smoothstep(0.75, 1.75, abs(vCurl));

  float a = c.a * edge * uAlpha * max(fade, 0.08);
  outColor = vec4(vec3(r, c.g, b) * a, a); // premultiplied
}`;

export function buildProgram(gl) {
  const make = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`shader: ${log}`);
    }
    return sh;
  };
  const vs = make(gl.VERTEX_SHADER, VERT);
  const fs = make(gl.FRAGMENT_SHADER, FRAG);
  const prog = gl.createProgram();
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog);
    gl.deleteProgram(prog);
    throw new Error(`link: ${log}`);
  }
  return prog;
}

/** A plane subdivided across x, so the bend has vertices to work with. */
export function buildPlane(gl, segments = 40) {
  const verts = [];
  for (let i = 0; i < segments; i += 1) {
    const x0 = i / segments - 0.5;
    const x1 = (i + 1) / segments - 0.5;
    verts.push(x0, -0.5, x1, -0.5, x1, 0.5, x0, -0.5, x1, 0.5, x0, 0.5);
  }
  const vao = gl.createVertexArray();
  const buf = gl.createBuffer();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { vao, buf, count: verts.length / 2 };
}

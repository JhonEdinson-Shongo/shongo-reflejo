// Every particle keeps a fixed place in the picture (its uv). The vertex shader reads
// the picture itself, so a new video frame costs one texture upload, not a buffer of
// points. Two layers (A and B) exist so one picture can dissolve into the next.

export const pointsVertex = /* glsl */ `
  uniform sampler2D uTexA;
  uniform sampler2D uTexB;
  uniform vec2 uPlaneA;      // world size of each layer
  uniform vec2 uPlaneB;
  uniform vec2 uTexelA;      // one step in the picture, for the relief blur
  uniform vec2 uTexelB;
  uniform float uLiveA;      // 1 when the layer's alpha carries motion (camera)
  uniform float uLiveB;
  uniform float uMorph;      // 0 → layer A, 1 → layer B
  uniform float uTime;
  uniform float uSize;
  uniform float uRelief;
  uniform float uScatter;
  uniform float uCalm;       // 0 when the user prefers reduced motion

  attribute vec3 aRnd;

  varying vec3 vCol;
  varying float vAlpha;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  // Relief reads a small neighbourhood: one raw pixel per point makes a spiky surface.
  float softLuma(sampler2D t, vec2 uv, vec2 s) {
    float l = luma(texture2D(t, uv).rgb) * 2.0;
    l += luma(texture2D(t, uv + vec2(s.x, 0.0)).rgb);
    l += luma(texture2D(t, uv - vec2(s.x, 0.0)).rgb);
    l += luma(texture2D(t, uv + vec2(0.0, s.y)).rgb);
    l += luma(texture2D(t, uv - vec2(0.0, s.y)).rgb);
    return l / 6.0;
  }

  void main() {
    vec2 uv = position.xy;
    float r0 = position.z;

    // Each point leaves on its own schedule, so the picture dissolves rather than cuts.
    float S = 0.6;
    float t = clamp(uMorph * (1.0 + S) - r0 * S, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    float mid = sin(3.14159265 * t);

    vec4 a = texture2D(uTexA, uv);
    vec4 b = texture2D(uTexB, uv);
    float lumA = softLuma(uTexA, uv, uTexelA * 3.0);
    float lumB = softLuma(uTexB, uv, uTexelB * 3.0);

    vec3 pa = vec3((uv - 0.5) * uPlaneA, (lumA - 0.5) * uRelief);
    vec3 pb = vec3((uv - 0.5) * uPlaneB, (lumB - 0.5) * uRelief);
    vec3 p = mix(pa, pb, t);

    vec3 n = vec3(
      sin(aRnd.x * 6.2831 + uTime * 0.7 + p.y * 3.1),
      cos(aRnd.y * 6.2831 + uTime * 0.6 + p.x * 2.7),
      sin(aRnd.z * 6.2831 + uTime * 0.5 + p.z * 2.3)
    );

    // In flight the points swirl, like sand caught by wind.
    p += n * mid * (0.3 + aRnd.x * 0.5) * uCalm;

    // Whatever moves in front of the camera blows its own particles away.
    float motion = mix(a.a * uLiveA, b.a * uLiveB, t);
    p += n * motion * uScatter * (0.25 + aRnd.y * 0.75) * uCalm;
    p.z += motion * uScatter * 0.6 * aRnd.z;

    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;

    // Light is drawn with size and alpha: the dark of the picture stays empty space.
    vec3 col = mix(a.rgb, b.rgb, t);
    // The curve lifts the shadows, where a face or a hand keeps most of its shape.
    float l = pow(luma(col), 0.65);
    gl_PointSize = uSize * (0.35 + l * 0.75) * (0.75 + aRnd.z * 0.5) * (1.0 + mid * 0.5 + motion * 0.6) / -mv.z;
    vCol = col / max(luma(col), 0.02) * mix(luma(col), l, 0.6);
    vAlpha = smoothstep(0.03, 0.2, l + motion * 0.2);
  }
`

export const pointsFragment = /* glsl */ `
  varying vec3 vCol;
  varying float vAlpha;

  void main() {
    float r = length(gl_PointCoord - 0.5);
    if (r > 0.5) discard;
    gl_FragColor = vec4(vCol, smoothstep(0.5, 0.15, r) * vAlpha);
  }
`

export const filterVertex = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

// One pass per camera frame: mirrors the image, averages it with the frames before
// (webcam noise makes points shimmer) and keeps a fading trace of motion in alpha.
export const filterFragment = /* glsl */ `
  uniform sampler2D uFrame;
  uniform sampler2D uPrev;
  uniform float uKeep;       // share of the previous frames in the result
  uniform float uMirror;

  varying vec2 vUv;

  float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

  void main() {
    vec2 uv = vec2(mix(vUv.x, 1.0 - vUv.x, uMirror), vUv.y);
    vec3 cur = texture2D(uFrame, uv).rgb;
    vec4 prev = texture2D(uPrev, vUv);
    float change = smoothstep(0.06, 0.3, abs(luma(cur) - luma(prev.rgb)));
    gl_FragColor = vec4(mix(cur, prev.rgb, uKeep), max(change, prev.a * 0.88));
  }
`

import { useEffect, useRef } from "react";
import { hexToRGB, resolveChroma } from "../../chroma";
import type { ChromaKey } from "../../types";

/*
A keyed clip in the preview.

Every other effect in this editor is approximated with a CSS filter, and chroma
key is the one that cannot be: CSS has no way to make a colour transparent. A
green screen shown unkeyed is not a rough approximation of the result, it is the
opposite of it — the composite the user is building is invisible until export,
which makes the key impossible to tune.

So this draws the video through a fragment shader. The <video> is still rendered
and still handed up via onVideo, so seeking, play/pause and the rest of the
preview engine keep driving it exactly as they do an unkeyed clip; it is simply
made invisible and used as a texture. Keeping the real element rather than
replacing it is what stops this feature from having its own playback path.

The shader approximates the export, as the preview always does. What it must NOT
approximate is what the controls mean — see chroma.ts.
*/

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  // A full-screen triangle pair in clip space; uv flipped so the texture is not
  // upside down (WebGL's origin is bottom-left, the video's is top-left).
  v_uv = vec2((a_pos.x + 1.0) / 2.0, 1.0 - (a_pos.y + 1.0) / 2.0);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `
precision mediump float;
uniform sampler2D u_tex;
uniform vec3 u_key;
uniform float u_sim;
uniform float u_blend;
uniform float u_spill;
varying vec2 v_uv;

// U and V only — the same reason the renderer uses chromakey over colorkey: a
// screen is never evenly lit, and dropping luma pulls its dim corner and its
// hot-spot much closer together. Closer, not identical: U and V still scale
// with intensity. ffmpeg behaves the same way, so the halves agree.
vec2 uv(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec2((c.b - y) * 0.565, (c.r - y) * 0.713);
}

void main() {
  vec4 px = texture2D(u_tex, v_uv);
  float d = distance(uv(px.rgb), uv(u_key));
  float a = clamp((d - u_sim) / max(u_blend, 0.0001), 0.0, 1.0);

  // Despill: the screen's light bouncing onto the subject. Pull green back to
  // whatever the other channels support, so a rim of green on hair or a
  // shoulder loses the cast without losing the pixel.
  vec3 rgb = px.rgb;
  if (u_spill > 0.0) {
    float m = max(rgb.r, rgb.b);
    if (rgb.g > m) rgb.g = mix(rgb.g, m, u_spill);
  }
  gl_FragColor = vec4(rgb, px.a * a);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

export function ChromaVideo({
  src,
  muted,
  style,
  chroma,
  onVideo,
}: {
  src: string;
  muted: boolean;
  style: React.CSSProperties;
  chroma: ChromaKey;
  onVideo: (el: HTMLVideoElement | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Read inside the draw loop so a slider move takes effect on the next frame
  // without tearing down the GL context.
  const settings = useRef(resolveChroma(chroma));
  settings.current = resolveChroma(chroma);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;

    const gl = canvas.getContext("webgl", { premultipliedAlpha: false, alpha: true });
    if (!gl) return; // no WebGL: the <video> below stays visible, unkeyed

    const prog = gl.createProgram();
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    if (!prog || !vs || !fs) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // CLAMP_TO_EDGE + LINEAR: video dimensions are rarely powers of two, and
    // anything else makes the texture render black.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const uKey = gl.getUniformLocation(prog, "u_key");
    const uSim = gl.getUniformLocation(prog, "u_sim");
    const uBlend = gl.getUniformLocation(prog, "u_blend");
    const uSpill = gl.getUniformLocation(prog, "u_spill");

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const w = video.videoWidth;
      const h = video.videoHeight;
      // readyState < 2 means there is no frame yet; uploading then throws.
      if (!w || !h || video.readyState < 2) return;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const s = settings.current;
      const [kr, kg, kb] = hexToRGB(s.color);
      gl.viewport(0, 0, w, h);
      gl.uniform3f(uKey, kr, kg, kb);
      gl.uniform1f(uSim, s.similarity);
      gl.uniform1f(uBlend, s.blend);
      gl.uniform1f(uSpill, s.spill);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      } catch {
        return; // a frame that isn't uploadable yet; try again next tick
      }
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buf);
      gl.deleteProgram(prog);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
    };
  }, []);

  return (
    <>
      <video
        ref={(el) => {
          videoRef.current = el;
          onVideo(el);
        }}
        src={src}
        muted={muted}
        playsInline
        // Kept in the tree and playing — the preview engine drives this element
        // — but invisible, because the canvas is what shows. opacity rather than
        // display/visibility so the browser keeps decoding frames to sample.
        style={{ position: "absolute", ...style, opacity: 0 }}
      />
      <canvas
        ref={canvasRef}
        style={{ position: "absolute", ...style, objectFit: "contain" }}
      />
    </>
  );
}

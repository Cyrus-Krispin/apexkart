// Renderer + post-processing with quality levels.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

// The grade: Neutral tone mapping, which keeps the Pit Wall's reds and oranges true where ACES
// turned them salmon (the start lights read orange), plus a touch of saturation so the stylised
// palette doesn't wash out. One function serves both paths: Low tone maps in every material,
// Medium and High once in the OutputPass. ALU only, so it costs nothing on any tier.
const NO_GRADE = 'vec3 CustomToneMapping( vec3 color ) { return color; }';
const GRADED = THREE.ShaderChunk.tonemapping_pars_fragment.includes(NO_GRADE);
if (GRADED)
  THREE.ShaderChunk.tonemapping_pars_fragment = THREE.ShaderChunk.tonemapping_pars_fragment.replace(
    NO_GRADE,
    /* glsl */ `vec3 CustomToneMapping( vec3 color ) {
  color = NeutralToneMapping( color );
  float l = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
  return clamp( mix( vec3( l ), color, 1.08 ), 0.0, 1.0 );
}`,
  );

export type Quality = 'high' | 'medium' | 'low';
export type QualitySetting = Quality | 'auto';

export function initialQuality(): QualitySetting {
  const saved = localStorage.getItem('ak:quality') as QualitySetting | null;
  return saved && ['auto', 'high', 'medium', 'low'].includes(saved) ? saved : 'auto';
}

/** Auto's first guess on a device it hasn't measured yet. */
export function autoQuality(): Quality {
  // Ambient occlusion roughly doubles the GPU work per frame, so Auto starts at Medium.
  // High stays available as a manual choice for strong GPUs.
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse || innerWidth < 700 ? 'low' : 'medium';
}

/** What Auto settled on for one GPU and screen, measured on the grid; later races start there. */
export interface AutoTier {
  tier: Quality;
  pixelRatio: number;
  gpu: string;
  screen: string;
  ms: number; // the synced warm-up frame time it was judged on
}

const AUTO_KEY = 'ak:autoTier';
const screenKey = () => `${screen.width}x${screen.height}@${devicePixelRatio}`;

/** Auto's earlier verdict for this GPU and screen, if there is one. */
export function loadAutoTier(gpu: string): AutoTier | null {
  try {
    const r = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null') as AutoTier | null;
    return r && r.gpu === gpu && r.screen === screenKey() && (r.tier === 'medium' || r.tier === 'low') && r.pixelRatio > 0 ? r : null;
  } catch {
    return null;
  }
}

export function saveAutoTier(t: Omit<AutoTier, 'screen'>): AutoTier {
  const rec = { ...t, screen: screenKey() };
  try {
    localStorage.setItem(AUTO_KEY, JSON.stringify(rec));
  } catch {
    /* private mode: measure again next time */
  }
  return rec;
}

/** Pixel-ratio range per tier. Low starts at 1 but may go higher on phones that measured fast enough. */
const RATIO: Record<Quality, { start: number; max: number }> = { high: { start: 1.5, max: 1.5 }, medium: { start: 1.25, max: 1.25 }, low: { start: 1, max: 2 } };
export const MIN_RATIO = 0.75;

/** The sharpest pixel ratio a tier may use on this screen. */
export function maxRatio(q: Quality) {
  return Math.min(devicePixelRatio, RATIO[q].max);
}

function gpuName(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || 'unknown');
}

/** Every texture the materials under `root` sample, for uploading before anything draws them. */
export function texturesUnder(root: THREE.Object3D): THREE.Texture[] {
  const out = new Set<THREE.Texture>();
  root.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (!m) return;
    for (const mat of Array.isArray(m) ? m : [m]) {
      for (const v of Object.values(mat)) if ((v as THREE.Texture | null)?.isTexture) out.add(v as THREE.Texture);
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const x of Object.values(u)) if ((x?.value as THREE.Texture | null)?.isTexture) out.add(x.value as THREE.Texture);
    }
  });
  return [...out].filter((t) => !(t as THREE.Texture & { isRenderTargetTexture?: boolean }).isRenderTargetTexture);
}

export interface BloomSettings {
  strength: number;
  radius: number;
  threshold: number;
}

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  /** The GPU's name, to remember Auto's verdict per device. */
  readonly gpu: string;
  quality: Quality;
  private composer: EffectComposer | null = null;
  private bloomPass: UnrealBloomPass | null = null;
  private bloom: BloomSettings = { strength: 0.32, radius: 0.45, threshold: 0.93 };
  private w = 1;
  private h = 1;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.shadowMap.enabled = true;
    // r186 dropped PCFSoft and swaps in PCF at the first shadow render. Shaders compiled before that
    // carry the old type in their cache key and compile again later, so name PCF from the start.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = GRADED ? THREE.CustomToneMapping : THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.quality = quality;
    this.gpu = gpuName(this.renderer.getContext());
  }

  /** Switch tier (render path and shaders): only ever on the grid or from the pause menu. */
  setQuality(q: Quality, ratio = RATIO[q].start) {
    this.quality = q;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.renderer.setPixelRatio(this.clampRatio(ratio));
    if (q !== 'low') {
      const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
      const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
      const composer = new EffectComposer(this.renderer, target);
      composer.addPass(new RenderPass(this.scene, this.camera));
      if (q === 'high') {
        const gtao = new GTAOPass(this.scene, this.camera, size.x, size.y);
        gtao.output = GTAOPass.OUTPUT.Default;
        gtao.blendIntensity = 0.9;
        gtao.updateGtaoMaterial({ radius: 1.4, distanceExponent: 1.4, thickness: 2.5, scale: 1.1, samples: 8, distanceFallOff: 1, screenSpaceRadius: false });
        gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 5, rings: 2, samples: 8 });
        composer.addPass(gtao);
      }
      const b = this.bloom;
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), b.strength, b.radius, b.threshold);
      composer.addPass(this.bloomPass);
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    this.setSize(this.w, this.h);
  }

  private clampRatio(r: number) {
    const hi = maxRatio(this.quality);
    return Math.max(Math.min(MIN_RATIO, hi), Math.min(hi, Math.round(r * 8) / 8));
  }

  get pixelRatio() {
    return this.renderer.getPixelRatio();
  }

  /** Dynamic resolution: the same shaders on fewer (or more) pixels. Safe mid-race. */
  setPixelRatio(r: number) {
    const v = this.clampRatio(r);
    if (v === this.renderer.getPixelRatio()) return;
    this.renderer.setPixelRatio(v);
    this.setSize(this.w, this.h);
  }

  /**
   * Render one frame and wait for the GPU to finish it (a 1-pixel read): CPU plus GPU time in ms.
   * An upper bound, as the two don't overlap here, but a fair one for choosing a tier.
   */
  timedRender(): number {
    const gl = this.renderer.getContext();
    const t0 = performance.now();
    this.render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.px);
    return performance.now() - t0;
  }
  private px = new Uint8Array(4);

  setBloom(b: BloomSettings) {
    this.bloom = { ...b };
    if (this.bloomPass) {
      this.bloomPass.strength = b.strength;
      this.bloomPass.radius = b.radius;
      this.bloomPass.threshold = b.threshold;
    }
  }

  setSize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.renderer.setSize(w, h);
    this.composer?.setSize(w, h);
    this.composer?.setPixelRatio(this.renderer.getPixelRatio());
  }

  render() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  /**
   * Compile the materials under `obj` for the target the scene really renders into: the composer's
   * on Medium/High, the screen on Low. Tone mapping and output colour space are baked into each
   * program from the target bound at compile time, so compiling against the wrong one builds
   * variants nothing draws with, and the real ones then compile mid-race on first sight.
   * `into` is the scene `obj` will be drawn in (its lights, fog and environment).
   */
  async compile(obj: THREE.Object3D, into: THREE.Scene = this.scene, q: Quality = this.quality) {
    const r = this.renderer;
    const prev = r.getRenderTarget();
    r.setRenderTarget(q === 'low' ? null : (this.composer?.renderTarget1 ?? this.probeTarget()));
    let done: Promise<unknown>;
    try {
      // The programs are created synchronously in here; the promise only waits for the driver.
      done = r.compileAsync(obj, this.camera, obj === into ? null : into);
    } finally {
      r.setRenderTarget(prev);
    }
    await done;
  }

  /** A stand-in render target with the composer's settings, for compiling Medium/High variants from Low. */
  private probe: THREE.WebGLRenderTarget | null = null;
  private probeTarget() {
    return (this.probe ??= new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
  }

  /** Bake an environment map from the sky so metal and paint pick up the sky colour. */
  bakeEnvironment(sky: THREE.Object3D, intensity = 0.55) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    const rt = pmrem.fromScene(envScene, 0.04, 0.1, 5000);
    this.scene.environment?.dispose();
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = intensity;
    pmrem.dispose();
  }

  dispose() {
    this.composer?.dispose();
    this.probe?.dispose();
    this.renderer.dispose();
  }
}

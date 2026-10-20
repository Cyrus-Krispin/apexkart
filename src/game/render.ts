// Renderer + post-processing with quality levels.
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export type Quality = 'high' | 'medium' | 'low';
export type QualitySetting = Quality | 'auto';

export function initialQuality(): QualitySetting {
  const saved = localStorage.getItem('ak:quality') as QualitySetting | null;
  return saved && ['auto', 'high', 'medium', 'low'].includes(saved) ? saved : 'auto';
}

export function autoQuality(): Quality {
  // Ambient occlusion roughly doubles the GPU work per frame, so Auto starts at Medium.
  // High stays available as a manual choice for strong GPUs.
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse || innerWidth < 700 ? 'low' : 'medium';
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
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.quality = quality;
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.composer?.dispose();
    this.composer = null;
    this.bloomPass = null;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, q === 'high' ? 1.5 : q === 'medium' ? 1.25 : 1));
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

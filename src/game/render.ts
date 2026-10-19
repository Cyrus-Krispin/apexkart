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

export class RenderPipeline {
  readonly renderer: THREE.WebGLRenderer;
  quality: Quality;
  private composer: EffectComposer | null = null;
  private w = 1;
  private h = 1;

  constructor(
    private scene: THREE.Scene,
    private camera: THREE.PerspectiveCamera,
    quality: Quality,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.quality = quality;
  }

  setQuality(q: Quality) {
    this.quality = q;
    this.composer?.dispose();
    this.composer = null;
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
      composer.addPass(new UnrealBloomPass(new THREE.Vector2(size.x / 2, size.y / 2), 0.32, 0.45, 0.93));
      composer.addPass(new OutputPass());
      this.composer = composer;
    }
    this.setSize(this.w, this.h);
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

  /** Bake an environment map from the sky so metal and paint pick up the sky colour. */
  bakeEnvironment(sky: THREE.Object3D) {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const envScene = new THREE.Scene();
    envScene.add(sky.clone());
    const rt = pmrem.fromScene(envScene, 0.04, 0.1, 5000);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.55;
    pmrem.dispose();
  }

  dispose() {
    this.composer?.dispose();
    this.renderer.dispose();
  }
}

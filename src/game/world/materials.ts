// World materials per tier, chosen once when the world is built (so nothing swaps mid-race).
import * as THREE from 'three';
import type { Quality } from '../render';

export type WorldMaterial = THREE.MeshStandardMaterial | THREE.MeshLambertMaterial;
export type MaterialFactory = (p: THREE.MeshStandardMaterialParameters) => WorldMaterial;

/**
 * Standard (PBR) on Medium and High; Lambert on Low, which skips the per-pixel GGX specular and the
 * environment's radiance lookup but keeps the same diffuse and the same ambient light from the sky
 * (three feeds Lambert the environment's irradiance too), so the world looks the same minus highlights
 * nobody sees on a phone. The kart stays Standard on every tier: paint and visor are where highlights read.
 */
export function materialFactory(q: Quality): MaterialFactory {
  if (q !== 'low') return (p) => new THREE.MeshStandardMaterial(p);
  return (p) => {
    const { roughness, metalness, roughnessMap, metalnessMap, envMapIntensity, ...rest } = p;
    void roughness;
    void roughnessMap;
    void metalnessMap;
    void envMapIntensity;
    const m = new THREE.MeshLambertMaterial(rest as THREE.MeshLambertMaterialParameters);
    // Metal is mostly reflection under PBR: without it, a darker diffuse stands in.
    if (metalness) m.color.multiplyScalar(1 - metalness * 0.45);
    return m;
  };
}

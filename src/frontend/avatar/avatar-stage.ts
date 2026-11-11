/**
 * The 3D stage behind the avatar panel: one small WebGL canvas showing a
 * head-and-torso character who blinks, breathes, turns her head, and moves her
 * mouth with Kookr's spoken summaries.
 *
 * This module pulls in three.js, so it must only ever be reached through the
 * lazy import in `App.tsx` — never import it from code that loads at startup.
 *
 * What is drawn, besides the character:
 *   - a soft bloom, so the glowing seams and gem actually glow;
 *   - slow particles whose drift shows her state: rising when idle, orbiting
 *     her head while a summary is being generated, radiating outward while she
 *     speaks;
 *   - a ring of thin bars behind her head that follows the loudness of the clip;
 *   - a bottom-to-top "scan" the first time she appears.
 *
 * The stage owns a WebGL context, and browsers allow only a handful per page
 * (Kookr's terminals use them too). So the stage is destroyed, not hidden, when
 * the panel is minimised: `dispose()` gives the context back.
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTFParser } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  SPEECH_VISEMES,
  createLipSyncState,
  createRng,
  damp,
  loudnessFromTimeDomain,
  stepLipSync,
} from './lip-sync.js';

/** What the character is doing, as shown by her particles and rings. */
export type AvatarState = 'idle' | 'thinking' | 'speaking';
const STATES: AvatarState[] = ['idle', 'thinking', 'speaking'];

export interface AvatarStageOptions {
  /** Element the canvas is appended to; the canvas fills it. */
  container: HTMLElement;
  /** URL of the avatar file (a .glb served from Kookr's own static assets). */
  modelUrl: string;
  /** Called once the character is loaded and the first frame is drawn. */
  onReady?: () => void;
  /** Called when the stage cannot run (no WebGL, lost context, load failure). */
  onError?: (reason: string) => void;
}

interface SpinFx { spin?: [number, number, number] }

const HEAD = new THREE.Vector3(0, 1.62, 0);
const PARTICLE_COUNT = 150;
const BAR_COUNT = 48;
const BAR_RADIUS = 0.34;

/** Slow, state-driven particle drift. `uW` holds the blend weights of idle / thinking / speaking. */
const PARTICLE_VERTEX = `
  attribute float aSeed, aSeed2;
  uniform float uTime, uA, uPx;
  uniform vec3 uW, uAnchor;
  varying float vAlpha; varying vec3 vCol;
  vec3 ramp(float t){ vec3 a=vec3(1.,.72,.28), b=vec3(.75,.55,1.), c=vec3(.45,.35,1.); return t<.5?mix(a,b,t*2.):mix(b,c,(t-.5)*2.); }
  void main(){
    vec3 home = position;
    float life = fract(uTime*(.03+.03*aSeed2)*(1.+uA*.4) + aSeed);
    float e = smoothstep(0.,1.,life);
    vec3 pIdle = home; pIdle.y = 0.95 + mod(home.y - 0.95 + uTime*(.012+.02*aSeed2), 1.35);
    pIdle.x += sin(uTime*.11+aSeed*30.)*.05; pIdle.z += cos(uTime*.09+aSeed*20.)*.05;
    float ang = aSeed*6.2831 + uTime*(.06+.08*aSeed2), rad = .36+.3*aSeed2+.05*sin(uTime*.5+aSeed*9.);
    vec3 pThink = uAnchor + vec3(cos(ang)*rad, (aSeed-.5)*.45, sin(ang)*rad*.6);
    vec3 d = home-uAnchor; vec3 pSpeak = uAnchor + normalize(d+vec3(.001))*(.16 + length(d)*1.05*e);
    vec3 we = uW*uW*(3.-2.*uW); we /= max(.0001, we.x+we.y+we.z);
    vec3 p = pIdle*we.x + pThink*we.y + pSpeak*we.z;
    vec4 mv = modelViewMatrix*vec4(p,1.);
    float y01 = clamp((pIdle.y-0.95)/1.35,0.,1.);
    float aIdle = smoothstep(0.,.15,y01)*(1.-smoothstep(.75,1.,y01)), aLife = sin(3.14159*life);
    float pure = smoothstep(.88,1.,max(uW.x,max(uW.y,uW.z)));
    float near = smoothstep(.45,1.1,-mv.z);
    vAlpha = (aIdle*uW.x + .75*uW.y + aLife*uW.z) * pure * near;
    gl_PointSize = min(9., 3.2*(.5+aSeed)*(1.+uA*.8)*uPx*(1.6/-mv.z));
    vCol = ramp(fract(aSeed*3.+y01*.6)) * 1.5;
    gl_Position = projectionMatrix*mv;
  }`;
const PARTICLE_FRAGMENT = `
  varying float vAlpha; varying vec3 vCol;
  void main(){ vec2 d = gl_PointCoord-.5; float a = smoothstep(.5,0.,length(d)); gl_FragColor = vec4(vCol, a*vAlpha); }`;

export class AvatarStage {
  private readonly container: HTMLElement;
  private readonly opts: AvatarStageOptions;
  private renderer: THREE.WebGLRenderer | null = null;
  private composer: EffectComposer | null = null;
  private bloom: UnrealBloomPass | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(30, 1, 0.05, 20);
  private readonly clock = new THREE.Clock();
  private raf = 0;
  private disposed = false;
  private ready = false;
  private resizeObserver: ResizeObserver | null = null;

  private state: AvatarState = 'idle';
  private readonly weights = [1, 0, 0];
  private readonly weightVel = [0, 0, 0];
  private analyser: AnalyserNode | null = null;
  private timeBuf: Uint8Array<ArrayBuffer> | null = null;
  private freqBuf: Uint8Array<ArrayBuffer> | null = null;
  private readonly lip = createLipSyncState();
  private readonly rng = createRng(1234);
  private time = 0;
  private scan = -0.25;
  private blinkIn = 1.6;
  private blinkT = -1;

  private morphMeshes: THREE.Mesh[] = [];
  private spinners: THREE.Object3D[] = [];
  private emissive: Array<{ material: THREE.MeshStandardMaterial; base: number }> = [];
  private pulses: Array<{ object: THREE.Object3D; scale: THREE.Vector3 }> = [];
  private head: THREE.Object3D | null = null;
  private chest: THREE.Object3D | null = null;
  private particles: THREE.Points | null = null;
  private bars: THREE.InstancedMesh | null = null;
  private readonly clip = new THREE.Plane(new THREE.Vector3(0, -1, 0), 0.9);
  private readonly reducedMotion: boolean;

  constructor(opts: AvatarStageOptions) {
    this.opts = opts;
    this.container = opts.container;
    this.reducedMotion =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    try {
      this.init();
    } catch (err) {
      this.fail(err instanceof Error ? err.message : String(err));
    }
  }

  private init(): void {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
    this.renderer = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.localClippingEnabled = true;
    const canvas = renderer.domElement;
    canvas.className = 'avatar-stage-canvas';
    canvas.setAttribute('aria-hidden', 'true');
    canvas.addEventListener('webglcontextlost', this.onContextLost);
    this.container.appendChild(canvas);

    this.scene.background = makeBackdrop();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.34;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.0);
    key.position.set(1.5, 3, 3);
    this.scene.add(key);
    const fill = new THREE.PointLight(0x9a6bff, 1.7, 4, 2);
    fill.position.set(0.5, 1.6, 1.1);
    this.scene.add(fill);
    const rim = new THREE.PointLight(0xf0b84a, 1.3, 4, 2);
    rim.position.set(-0.6, 1.8, -0.8);
    this.scene.add(rim);

    this.camera.position.set(0, 1.585, 1.34);
    this.camera.lookAt(0, 1.535, 0);

    const composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.72, 0.5, 0.86);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    this.composer = composer;

    this.addParticles();
    this.addBars();
    this.resize();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(this.container);
    }
    document.addEventListener('visibilitychange', this.onVisibility);
    this.load();
  }

  private load(): void {
    const loader = new GLTFLoader();
    // Kookr's Content-Security-Policy allows blob: images but not blob: fetches,
    // and GLTFLoader's default (ImageBitmapLoader) fetches. Decode the embedded
    // textures through <img> elements instead.
    loader.register((parser: GLTFParser) => {
      (parser as unknown as { textureLoader: THREE.Loader }).textureLoader = new THREE.TextureLoader(parser.options.manager);
      return { name: 'KOOKR_img_texture_loader' };
    });
    loader.load(
      this.opts.modelUrl,
      (gltf) => {
        if (this.disposed) return;
        this.adopt(gltf.scene);
        this.ready = true;
        this.clock.start();
        this.start();
        this.opts.onReady?.();
      },
      undefined,
      (err) => this.fail(err instanceof Error ? err.message : 'avatar file failed to load'),
    );
  }

  /** Index the loaded character: face meshes, turning parts, glowing materials. */
  private adopt(root: THREE.Object3D): void {
    this.scene.add(root);
    root.traverse((object) => {
      if (object.name === 'Head') this.head = object;
      if (object.name === 'Spine2') this.chest = object;
      const fx = (object.userData as { lucyFx?: SpinFx }).lucyFx;
      if (fx?.spin) this.spinners.push(object);
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false;
      if (mesh.morphTargetDictionary) this.morphMeshes.push(mesh);
      if (/^FX_(Forehead|Reactor(Glow|Core))/.test(mesh.name)) {
        this.pulses.push({ object: mesh, scale: mesh.scale.clone() });
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        material.clippingPlanes = [this.clip];
        const standard = material as THREE.MeshStandardMaterial;
        if (standard.emissiveIntensity > 0 && (standard.emissiveMap || standard.emissive?.getHex())) {
          this.emissive.push({ material: standard, base: standard.emissiveIntensity });
        }
      }
    });
    if (this.reducedMotion) this.scan = 2;
  }

  private addParticles(): void {
    const pos = new Float32Array(PARTICLE_COUNT * 3);
    const seed = new Float32Array(PARTICLE_COUNT);
    const seed2 = new Float32Array(PARTICLE_COUNT);
    const rnd = createRng(4321);
    for (let i = 0; i < PARTICLE_COUNT; i += 1) {
      const a = rnd() * Math.PI * 2;
      const r = 0.32 + Math.sqrt(rnd()) * 0.62;
      pos.set([Math.cos(a) * r, 0.95 + rnd() * 1.35, Math.sin(a) * r * 0.8 - 0.1], i * 3);
      seed[i] = rnd();
      seed2[i] = rnd();
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute('aSeed', new THREE.BufferAttribute(seed, 1));
    geometry.setAttribute('aSeed2', new THREE.BufferAttribute(seed2, 1));
    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: { value: 0 },
        uA: { value: 0 },
        uPx: { value: this.renderer?.getPixelRatio() ?? 1 },
        uW: { value: new THREE.Vector3(1, 0, 0) },
        uAnchor: { value: HEAD.clone() },
      },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
    });
    this.particles = new THREE.Points(geometry, material);
    this.particles.frustumCulled = false;
    this.scene.add(this.particles);
  }

  private addBars(): void {
    const geometry = new THREE.BoxGeometry(0.006, 1, 0.004).translate(0, 0.5, 0);
    const material = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0xf0b84a).multiplyScalar(2),
      transparent: true,
      opacity: 0.9,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    this.bars = new THREE.InstancedMesh(geometry, material, BAR_COUNT);
    this.bars.position.set(0, 1.665, -0.115);
    this.bars.frustumCulled = false;
    this.scene.add(this.bars);
  }

  /** Switch what the particles and rings show. Safe to call at any time. */
  setState(state: AvatarState): void {
    this.state = state;
  }

  /** Give the stage a tap on the playing clip (or null when nothing plays). */
  setAnalyser(analyser: AnalyserNode | null): void {
    this.analyser = analyser;
    if (analyser) {
      this.timeBuf = new Uint8Array(new ArrayBuffer(analyser.fftSize));
      this.freqBuf = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
    } else {
      this.timeBuf = null;
      this.freqBuf = null;
    }
  }

  /** A still image of the current frame, for the minimised bubble. Null before the first frame. */
  snapshot(): string | null {
    if (!this.ready || !this.renderer || !this.composer) return null;
    try {
      this.composer.render();
      return this.renderer.domElement.toDataURL('image/jpeg', 0.82);
    } catch {
      return null;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.resizeObserver?.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof THREE.Texture) value.dispose();
        }
        material.dispose();
      }
    });
    (this.scene.background as THREE.Texture | null)?.dispose?.();
    this.scene.environment?.dispose();
    this.composer?.dispose();
    if (this.renderer) {
      const canvas = this.renderer.domElement;
      canvas.removeEventListener('webglcontextlost', this.onContextLost);
      this.renderer.dispose();
      this.renderer.forceContextLoss();
      canvas.remove();
    }
    this.renderer = null;
    this.composer = null;
  }

  private fail(reason: string): void {
    if (this.disposed) return;
    this.opts.onError?.(reason);
    this.dispose();
  }

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    this.fail('the browser took back the graphics context');
  };

  private readonly onVisibility = (): void => {
    if (document.visibilityState === 'hidden') cancelAnimationFrame(this.raf);
    else this.start();
  };

  private start(): void {
    if (this.disposed || !this.ready) return;
    cancelAnimationFrame(this.raf);
    this.clock.getDelta();
    const loop = (): void => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      this.step(Math.min(0.05, this.clock.getDelta()));
      this.composer?.render();
    };
    this.raf = requestAnimationFrame(loop);
  }

  private resize(): void {
    if (!this.renderer || !this.composer) return;
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private setMorph(name: string, value: number): void {
    for (const mesh of this.morphMeshes) {
      const index = mesh.morphTargetDictionary?.[name];
      if (index !== undefined && mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = value;
    }
  }

  /** Advance everything by `dt` seconds. */
  private step(dt: number): void {
    this.time += dt;
    const t = this.time;

    // State weights follow a critically damped spring, so a state change never starts with a jump.
    const omega = 2.4;
    STATES.forEach((name, k) => {
      const acc = omega * omega * ((name === this.state ? 1 : 0) - this.weights[k]) - 2 * omega * this.weightVel[k];
      this.weightVel[k] += acc * dt;
      this.weights[k] += this.weightVel[k] * dt;
    });
    const [wIdle, wThink, wSpeak] = this.weights;

    // Mouth: loudness of the playing clip.
    let loudness = 0;
    if (this.analyser && this.timeBuf) {
      this.analyser.getByteTimeDomainData(this.timeBuf);
      loudness = loudnessFromTimeDomain(this.timeBuf) * 1.15;
    }
    stepLipSync(this.lip, loudness, dt, this.rng);
    const amp = this.lip.amp;
    for (const viseme of SPEECH_VISEMES) this.setMorph(viseme, this.lip.weights[viseme] * 0.9);
    this.setMorph('jawOpen', amp * 0.35);
    this.setMorph('mouthSmile', 0.12 + 0.08 * Math.sin(t * 0.5));

    // Blink every 2 to 5.5 seconds.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && this.blinkT < 0) {
      this.blinkT = 0;
      this.blinkIn = 2 + this.rng() * 3.5;
    }
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const lid = Math.sin(Math.min(1, this.blinkT / 0.16) * Math.PI);
      this.setMorph('eyeBlinkLeft', lid);
      this.setMorph('eyeBlinkRight', lid);
      if (this.blinkT > 0.16) this.blinkT = -1;
    }

    // Idle motion: a slow head sway and a breath. With "reduce motion" set in the operating system the sway is
    // much smaller and the purely decorative movement (rings, particles) stops; her mouth still moves, because
    // that carries information.
    const motion = this.reducedMotion ? 0.3 : 1;
    const ambient = this.reducedMotion ? 0 : 1;
    if (this.head) {
      this.head.rotation.y = Math.sin(t * 0.45) * 0.14 * motion;
      this.head.rotation.x = 0.03 + Math.sin(t * 0.33) * 0.035 * motion - amp * 0.03;
    }
    if (this.chest) this.chest.rotation.x = Math.sin(t * 1.1) * 0.01 * motion;

    // Rings: calm when idle, busy while thinking, livelier with her voice.
    const boost = wIdle + wThink * 2.4 + wSpeak * (1 + amp * 1.5);
    for (const object of this.spinners) {
      const spin = (object.userData as { lucyFx: SpinFx }).lucyFx.spin;
      if (!spin) continue;
      object.rotation.x += spin[0] * dt * boost * 0.6 * ambient;
      object.rotation.y += spin[1] * dt * boost * 0.6 * ambient;
      object.rotation.z += spin[2] * dt * boost * 0.6 * ambient;
    }
    const pulse = 1 + amp * 0.55 + 0.1 * Math.sin(t * 2.1);
    for (const entry of this.emissive) entry.material.emissiveIntensity = entry.base * pulse;
    for (const entry of this.pulses) {
      entry.object.scale.copy(entry.scale).multiplyScalar(1 + amp * 0.5 + 0.08 * Math.sin(t * 2.6));
    }
    if (this.bloom) this.bloom.strength += (0.72 + wSpeak * 0.12 - this.bloom.strength) * damp(3, dt);

    // First appearance: reveal from the belt upward.
    this.scan += dt;
    const reveal = Math.max(0, Math.min(1, this.scan / 1.2));
    this.clip.constant = this.scan < 0 ? 0.9 : this.scan > 1.3 ? 9 : 0.9 + reveal * 1.4;

    if (this.particles) {
      const uniforms = (this.particles.material as THREE.ShaderMaterial).uniforms;
      uniforms.uTime.value = t * ambient;
      uniforms.uA.value = amp;
      (uniforms.uW.value as THREE.Vector3).set(wIdle, wThink, wSpeak);
    }
    this.updateBars(amp, t);
  }

  private readonly barMatrix = new THREE.Matrix4();
  private readonly barQuat = new THREE.Quaternion();
  private readonly barPos = new THREE.Vector3();
  private readonly barScale = new THREE.Vector3();
  private static readonly Z = new THREE.Vector3(0, 0, 1);

  /** Ring of bars behind the head: the clip's spectrum while she speaks, a faint shimmer otherwise. */
  private updateBars(amp: number, t: number): void {
    if (!this.bars) return;
    if (this.analyser && this.freqBuf) this.analyser.getByteFrequencyData(this.freqBuf);
    for (let i = 0; i < BAR_COUNT; i += 1) {
      const angle = (i / BAR_COUNT) * Math.PI * 2;
      const mirrored = Math.min(i, BAR_COUNT - i) / (BAR_COUNT / 2);
      const level = this.analyser && this.freqBuf ? this.freqBuf[Math.floor(mirrored * 60)] / 255 : 0;
      const length = 0.008 + 0.01 * (0.5 + 0.5 * Math.sin(t * 0.8 + i * 0.5)) * (1 - amp) + level * 0.1;
      this.barQuat.setFromAxisAngle(AvatarStage.Z, angle - Math.PI / 2);
      this.barPos.set(Math.cos(angle) * BAR_RADIUS, Math.sin(angle) * BAR_RADIUS, 0);
      this.barScale.set(1, length, 1);
      this.bars.setMatrixAt(i, this.barMatrix.compose(this.barPos, this.barQuat, this.barScale));
    }
    this.bars.instanceMatrix.needsUpdate = true;
  }
}

/** A dark violet radial gradient, so the panel is not a flat black box. */
function makeBackdrop(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const g = canvas.getContext('2d');
  if (g) {
    const gradient = g.createRadialGradient(128, 104, 6, 128, 128, 190);
    gradient.addColorStop(0, '#16102e');
    gradient.addColorStop(1, '#030208');
    g.fillStyle = gradient;
    g.fillRect(0, 0, 256, 256);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

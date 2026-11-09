import * as THREE from 'three'
import { filterFragment, filterVertex, pointsFragment, pointsVertex } from './shaders'

/** Something the particles can show: a still picture or the live camera. */
export interface Layer {
  texture: THREE.Texture
  /** Width / height. */
  aspect: number
  /** Pixel size of `texture`. */
  w: number
  h: number
  live: boolean
}

export interface Settings {
  /** Points on screen. */
  count: number
  /** Point size multiplier. */
  size: number
  /** Depth given by brightness, in world units. */
  relief: number
  /** 0 = raw camera, towards 1 = heavily averaged. */
  smoothing: number
  /** How far motion throws the points. */
  scatter: number
}

const FOV = 35
const CAM_Z = 8
const MORPH_SECONDS = 1.8
const FILTER_WIDTH = 640
/** Point diameter at full brightness, in gaps between points. */
const POINT_FILL = 1.5
const GROUND = 0x060607

export class ParticleStage {
  readonly settings: Settings
  /** Frames per second, averaged over the last half second. */
  fps = 0

  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100)
  private group = new THREE.Group()
  private geo = new THREE.BufferGeometry()
  private mat: THREE.ShaderMaterial
  private layerA: Layer
  private layerB: Layer
  private morph = -1
  private morphDone: (() => void) | null = null
  private pointer = { x: 0, y: 0 }
  private tilt = { x: 0, y: 0 }
  private pr = 1
  private last = 0
  private frames = 0
  private fpsFrom = 0

  // The camera's filter pass: two targets, each frame reads one and writes the other.
  private filterScene = new THREE.Scene()
  private filterCam = new THREE.Camera()
  private filterMat: THREE.ShaderMaterial
  private targets: [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget] | null = null
  private video: { source: THREE.VideoTexture; layer: Layer; fresh: boolean; handle: number; el: HTMLVideoElement } | null = null

  constructor(
    private canvas: HTMLCanvasElement,
    first: Layer,
    settings: Settings,
    private maxCount: number,
    private reduced: boolean,
  ) {
    this.settings = settings
    this.layerA = first
    this.layerB = first
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' })
    this.renderer.setClearColor(GROUND, 1)
    this.camera.position.set(0, 0, CAM_Z)

    // R2 low-discrepancy sequence: any prefix of it covers the picture evenly, so the
    // density control is just a draw range, and there is no grid for the eye to catch.
    const G = 1.32471795724
    const a1 = 1 / G
    const a2 = 1 / (G * G)
    const pos = new Float32Array(maxCount * 3)
    const rnd = new Float32Array(maxCount * 3)
    for (let i = 0; i < maxCount; i++) {
      pos[i * 3] = (0.5 + a1 * i) % 1
      pos[i * 3 + 1] = (0.5 + a2 * i) % 1
      pos[i * 3 + 2] = Math.random()
      rnd[i * 3] = Math.random()
      rnd[i * 3 + 1] = Math.random()
      rnd[i * 3 + 2] = Math.random()
    }
    this.geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
    this.geo.setAttribute('aRnd', new THREE.BufferAttribute(rnd, 3))

    this.mat = new THREE.ShaderMaterial({
      vertexShader: pointsVertex,
      fragmentShader: pointsFragment,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      uniforms: {
        uTexA: { value: first.texture },
        uTexB: { value: first.texture },
        uPlaneA: { value: new THREE.Vector2(1, 1) },
        uPlaneB: { value: new THREE.Vector2(1, 1) },
        uTexelA: { value: new THREE.Vector2(1 / first.w, 1 / first.h) },
        uTexelB: { value: new THREE.Vector2(1 / first.w, 1 / first.h) },
        uLiveA: { value: 0 },
        uLiveB: { value: 0 },
        uMorph: { value: 0 },
        uTime: { value: 0 },
        uSize: { value: 1 },
        uRelief: { value: 0 },
        uScatter: { value: 0 },
        uCalm: { value: reduced ? 0 : 1 },
      },
    })
    const points = new THREE.Points(this.geo, this.mat)
    points.frustumCulled = false
    this.group.add(points)
    this.scene.add(this.group)

    this.filterMat = new THREE.ShaderMaterial({
      vertexShader: filterVertex,
      fragmentShader: filterFragment,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        uFrame: { value: null },
        uPrev: { value: null },
        uKeep: { value: 0 },
        uMirror: { value: 1 },
      },
    })
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.filterMat)
    quad.frustumCulled = false
    this.filterScene.add(quad)

    window.addEventListener('resize', this.resize)
    window.addEventListener('pointermove', this.onPointer, { passive: true })
    this.resize()
    this.renderer.setAnimationLoop(this.frame)
  }

  /** Dissolves into `next`. Resolves when the morph ends. */
  show(next: Layer): Promise<void> {
    // A morph in flight jumps to its end: B becomes the start of the new one.
    if (this.morph >= 0) this.finishMorph()
    if (next === this.layerA) return Promise.resolve()
    this.layerB = next
    this.applyLayers()
    return new Promise((resolve) => {
      this.morph = 0
      this.morphDone = resolve
    })
  }

  get current() {
    return this.morph >= 0 ? this.layerB : this.layerA
  }

  /** The layer for a live video. Only one can be attached at a time. */
  attachVideo(el: HTMLVideoElement, mirror: boolean): Layer {
    // Detaching frees the old targets, so no morph may still be reading them.
    if (this.morph >= 0) this.finishMorph()
    const old = this.video?.layer
    this.detachVideo()
    const w = Math.min(el.videoWidth, FILTER_WIDTH)
    const h = Math.round((w * el.videoHeight) / el.videoWidth)
    const options = {
      // Half floats: at 8 bits a strong average never quite reaches the new value.
      type: this.renderer.extensions.has('EXT_color_buffer_float') || this.renderer.extensions.has('EXT_color_buffer_half_float') ? THREE.HalfFloatType : THREE.UnsignedByteType,
      depthBuffer: false,
      generateMipmaps: false,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    }
    this.targets = [new THREE.WebGLRenderTarget(w, h, options), new THREE.WebGLRenderTarget(w, h, options)]
    const source = new THREE.VideoTexture(el)
    source.needsUpdate = true // the texture's own frame callback has not fired yet
    const layer: Layer = { texture: this.targets[0].texture, aspect: el.videoWidth / el.videoHeight, w, h, live: true }
    this.video = { source, layer, fresh: true, handle: 0, el }
    this.filterMat.uniforms.uFrame.value = source
    this.filterMat.uniforms.uMirror.value = mirror ? 1 : 0
    this.watchFrames()
    // Fill both targets with the first frame, so nothing fades in from black.
    this.filterMat.uniforms.uKeep.value = 0
    this.filterPass()
    this.filterPass()
    // Switching cameras: the new one takes the old one's place without a morph.
    if (old && this.layerA === old) {
      this.layerA = this.layerB = layer
      this.applyLayers()
    }
    return layer
  }

  detachVideo() {
    if (!this.video) return
    const { el, handle, source } = this.video
    if (handle && 'cancelVideoFrameCallback' in el) el.cancelVideoFrameCallback(handle)
    source.dispose()
    this.targets?.forEach((t) => t.dispose())
    this.targets = null
    this.video = null
  }

  /** PNG of what is on screen, drawn fresh: the drawing buffer is not kept between frames. */
  snapshot(): Promise<Blob | null> {
    this.renderer.render(this.scene, this.camera)
    return new Promise((resolve) => this.canvas.toBlob(resolve, 'image/png'))
  }

  private watchFrames() {
    const v = this.video
    if (!v || !('requestVideoFrameCallback' in v.el)) return
    const tick = () => {
      if (this.video !== v) return
      v.fresh = true
      v.handle = v.el.requestVideoFrameCallback(tick)
    }
    v.handle = v.el.requestVideoFrameCallback(tick)
  }

  private filterPass() {
    const v = this.video
    const targets = this.targets
    if (!v || !targets) return
    const [read, write] = targets
    this.filterMat.uniforms.uPrev.value = read.texture
    this.renderer.setRenderTarget(write)
    this.renderer.render(this.filterScene, this.filterCam)
    this.renderer.setRenderTarget(null)
    this.targets = [write, read]
    v.layer.texture = write.texture
  }

  private applyLayers() {
    const u = this.mat.uniforms
    const put = (l: Layer, side: 'A' | 'B') => {
      u[`uTex${side}`].value = l.texture
      u[`uLive${side}`].value = l.live ? 1 : 0
      u[`uTexel${side}`].value.set(1 / l.w, 1 / l.h)
      this.fit(l, u[`uPlane${side}`].value)
    }
    put(this.layerA, 'A')
    put(this.layerB, 'B')
  }

  /** The largest plane of the layer's aspect that fits the view, with a small margin. */
  private fit(l: Layer, out: THREE.Vector2) {
    const viewH = 2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAM_Z * 0.86
    const viewW = viewH * this.camera.aspect
    const h = Math.min(viewH, viewW / l.aspect)
    out.set(h * l.aspect, h)
  }

  /**
   * A point's size follows the room it has: the picture's area on screen divided by
   * the points. So it keeps its body on a phone and at any density.
   */
  private pointSize(count: number) {
    const plane = this.mat.uniforms[this.morph >= 0 ? 'uPlaneB' : 'uPlaneA'].value as THREE.Vector2
    const pxPerUnit = (this.canvas.clientHeight * this.pr) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * CAM_Z)
    const spacing = Math.sqrt((plane.x * plane.y * pxPerUnit * pxPerUnit) / count)
    return spacing * POINT_FILL * this.settings.size * CAM_Z
  }

  private finishMorph() {
    this.layerA = this.layerB
    this.morph = -1
    this.mat.uniforms.uMorph.value = 0
    this.applyLayers()
    const done = this.morphDone
    this.morphDone = null
    done?.()
  }

  private onPointer = (e: PointerEvent) => {
    this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1
    this.pointer.y = (e.clientY / window.innerHeight) * 2 - 1
  }

  private resize = () => {
    const w = this.canvas.clientWidth || window.innerWidth
    const h = this.canvas.clientHeight || window.innerHeight
    this.pr = Math.min(window.devicePixelRatio || 1, 1.75)
    this.renderer.setPixelRatio(this.pr)
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.applyLayers()
  }

  private frame = (now: number) => {
    const dt = Math.min((now - this.last) / 1000, 0.05)
    this.last = now
    this.countFps(now)

    const s = this.settings
    const v = this.video
    if (v && (v.fresh || !('requestVideoFrameCallback' in v.el))) {
      v.fresh = false
      this.filterMat.uniforms.uKeep.value = s.smoothing
      this.filterPass()
      // The layer's texture swaps every frame; whichever side shows it must follow.
      if (this.layerA === v.layer) this.mat.uniforms.uTexA.value = v.layer.texture
      if (this.layerB === v.layer) this.mat.uniforms.uTexB.value = v.layer.texture
    }

    if (this.morph >= 0) {
      this.morph += dt / (this.reduced ? 0.5 : MORPH_SECONDS)
      if (this.morph >= 1) this.finishMorph()
      else this.mat.uniforms.uMorph.value = this.morph
    }

    const count = Math.min(s.count, this.maxCount)
    this.geo.setDrawRange(0, count)
    const u = this.mat.uniforms
    u.uSize.value = this.pointSize(count)
    u.uRelief.value = s.relief
    u.uScatter.value = s.scatter
    u.uTime.value = now / 1000

    // The view leans with the pointer: it is what lets the relief read as depth.
    if (!this.reduced) {
      this.tilt.x += (this.pointer.x * 0.13 - this.tilt.x) * 0.06
      this.tilt.y += (this.pointer.y * 0.09 - this.tilt.y) * 0.06
      this.group.rotation.set(this.tilt.y, this.tilt.x, 0)
    }

    this.renderer.render(this.scene, this.camera)
  }

  private countFps(now: number) {
    this.frames++
    if (now - this.fpsFrom < 500) return
    this.fps = (this.frames * 1000) / (now - this.fpsFrom)
    this.frames = 0
    this.fpsFrom = now
  }
}

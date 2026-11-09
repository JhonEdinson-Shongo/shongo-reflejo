import * as THREE from 'three'
import type { Layer } from './stage'

const MAX_IMAGE_SIDE = 1024

function canvasLayer(c: HTMLCanvasElement): Layer {
  const texture = new THREE.CanvasTexture(c)
  texture.generateMipmaps = false
  texture.minFilter = THREE.LinearFilter
  return { texture, aspect: c.width / c.height, w: c.width, h: c.height, live: false }
}

/** Nothing at all: the particles start here and gather into the title. */
export function blankLayer(): Layer {
  const c = document.createElement('canvas')
  c.width = c.height = 2
  c.getContext('2d')!.fillRect(0, 0, 2, 2)
  return canvasLayer(c)
}

/** The opening picture, shown before the visitor picks a source. */
export function titleLayer(portrait: boolean): Layer {
  const c = document.createElement('canvas')
  c.width = portrait ? 720 : 1280
  c.height = portrait ? 900 : 720
  const g = c.getContext('2d')!
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.fillStyle = '#f3f1ec'
  g.font = `800 ${portrait ? 124 : 190}px "Syne", "Arial Black", sans-serif`
  g.fillText('reflejo', c.width / 2, c.height * 0.46)
  // The page's accent, so the title follows the theme.
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  g.font = `500 ${portrait ? 34 : 44}px "JetBrains Mono", ui-monospace, monospace`
  g.fillText('tu imagen, en partículas', c.width / 2, c.height * (portrait ? 0.6 : 0.66))
  return canvasLayer(c)
}

export interface ImageSource {
  layer: Layer
  /** Small preview for the source list. */
  thumb: string
  name: string
}

export async function loadImage(file: File): Promise<ImageSource> {
  // `imageOrientation` honours the EXIF rotation that phone photos rely on.
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  const k = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
  const c = document.createElement('canvas')
  c.width = Math.round(bitmap.width * k)
  c.height = Math.round(bitmap.height * k)
  const g = c.getContext('2d')!
  // Transparent images sit on black, which the particles read as empty space.
  g.fillStyle = '#000'
  g.fillRect(0, 0, c.width, c.height)
  g.drawImage(bitmap, 0, 0, c.width, c.height)
  bitmap.close()

  const t = document.createElement('canvas')
  const tk = 96 / Math.max(c.width, c.height)
  t.width = Math.round(c.width * tk)
  t.height = Math.round(c.height * tk)
  t.getContext('2d')!.drawImage(c, 0, 0, t.width, t.height)
  return { layer: canvasLayer(c), thumb: t.toDataURL('image/jpeg', 0.8), name: file.name }
}

export type Facing = 'user' | 'environment'

export class CameraError extends Error {
  constructor(message: string) {
    super(message)
  }
}

function explain(e: unknown): string {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'El navegador no tiene permiso para usar la cámara. Actívalo en los ajustes del sitio y vuelve a intentarlo.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'No encontramos ninguna cámara en este dispositivo.'
  if (name === 'NotReadableError') return 'Otra aplicación está usando la cámara. Ciérrala y vuelve a intentarlo.'
  return 'No se pudo abrir la cámara. Vuelve a intentarlo.'
}

/** Owns the `<video>` and its stream. Nothing here leaves the device. */
export class Camera {
  readonly el = document.createElement('video')
  facing: Facing = 'user'
  private stream: MediaStream | null = null

  constructor() {
    // iOS Safari only plays inline, muted video without a gesture on the element itself.
    this.el.playsInline = true
    this.el.muted = true
  }

  get on() {
    return this.stream !== null
  }

  async start(facing: Facing = this.facing) {
    if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('La cámara solo funciona en una conexión segura (HTTPS).')
    this.stop()
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } },
      })
      this.el.srcObject = this.stream
      await this.el.play()
      this.facing = facing
    } catch (e) {
      this.stop()
      throw new CameraError(explain(e))
    }
  }

  /** Releases the device, which also turns off its light. */
  stop() {
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    this.el.srcObject = null
  }

  async hasSeveral() {
    const devices = await navigator.mediaDevices.enumerateDevices()
    return devices.filter((d) => d.kind === 'videoinput').length > 1
  }
}

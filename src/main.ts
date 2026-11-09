import '@fontsource/jetbrains-mono/latin-400.css'
import '@fontsource/jetbrains-mono/latin-500.css'
import '@fontsource/syne/latin-800.css'
import './styles/main.css'
import { blankLayer, Camera, CameraError, loadImage, titleLayer, type Facing, type ImageSource } from './engine/sources'
import { ParticleStage, type Layer, type Settings } from './engine/stage'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8
const small = window.innerWidth < 860 || mem < 4
const DEFAULT_COUNT = small ? 48000 : 110000
const MAX_COUNT = small ? 200000 : 500000
const nf = new Intl.NumberFormat('es-CO')

async function boot() {
  // The title is drawn into a canvas, so its fonts must be ready first.
  await Promise.all([document.fonts.load('800 190px "Syne"'), document.fonts.load('500 44px "JetBrains Mono"')]).catch(() => {})

  const settings: Settings = { count: DEFAULT_COUNT, size: 1, relief: 0.5, smoothing: 0.5, scatter: 0.5 }
  const title = titleLayer(window.innerHeight > window.innerWidth)
  const stage = new ParticleStage($<HTMLCanvasElement>('stage'), blankLayer(), settings, MAX_COUNT, reduced)
  const camera = new Camera()
  let cameraLayer: Layer | null = null
  const images: ImageSource[] = []

  const cameraBtn = $<HTMLButtonElement>('camera')
  const flipBtn = $<HTMLButtonElement>('flip')
  const thumbs = $('thumbs')
  const toast = $('toast')
  let toastTimer = 0

  function say(message: string) {
    toast.textContent = message
    toast.hidden = false
    clearTimeout(toastTimer)
    toastTimer = window.setTimeout(() => (toast.hidden = true), 6000)
  }

  function refresh() {
    const live = cameraLayer !== null
    cameraBtn.textContent = live ? 'Apagar cámara' : 'Activar cámara'
    cameraBtn.setAttribute('aria-pressed', String(live))
    for (const b of thumbs.querySelectorAll<HTMLButtonElement>('button')) {
      const shown = images[Number(b.dataset.i)]?.layer === stage.current
      b.setAttribute('aria-pressed', String(shown))
    }
  }

  async function openCamera(facing?: Facing) {
    await camera.start(facing)
    const layer = stage.attachVideo(camera.el, camera.facing === 'user')
    cameraLayer = layer
    refresh()
    await stage.show(layer)
  }

  /** Dissolves away from the camera, and only then releases the device. */
  async function closeCamera(next: Layer) {
    const old = cameraLayer
    cameraLayer = null
    flipBtn.hidden = true
    refresh()
    await stage.show(next)
    if (old && !cameraLayer) {
      stage.detachVideo()
      camera.stop()
    }
    refresh()
  }

  cameraBtn.addEventListener('click', async () => {
    cameraBtn.disabled = true
    try {
      if (cameraLayer) {
        await closeCamera(images.at(-1)?.layer ?? title)
      } else {
        await openCamera()
        flipBtn.hidden = !(await camera.hasSeveral())
      }
    } catch (e) {
      say(e instanceof CameraError ? e.message : 'No se pudo abrir la cámara. Vuelve a intentarlo.')
    }
    cameraBtn.disabled = false
    refresh()
  })

  flipBtn.addEventListener('click', async () => {
    flipBtn.disabled = true
    try {
      await camera.start(camera.facing === 'user' ? 'environment' : 'user')
      cameraLayer = stage.attachVideo(camera.el, camera.facing === 'user')
    } catch (e) {
      say(e instanceof CameraError ? e.message : 'No se pudo cambiar de cámara.')
    }
    flipBtn.disabled = false
  })

  // Turning a phone swaps the video's width and height.
  camera.el.addEventListener('resize', () => {
    const { videoWidth: w, videoHeight: h } = camera.el
    if (cameraLayer && w && h && Math.abs(cameraLayer.aspect - w / h) > 0.01) cameraLayer = stage.attachVideo(camera.el, camera.facing === 'user')
  })

  function showImage(img: ImageSource) {
    const shown = cameraLayer ? closeCamera(img.layer) : stage.show(img.layer)
    refresh()
    return shown.then(refresh)
  }

  async function addFiles(files: Iterable<File>) {
    let latest: ImageSource | null = null
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      try {
        const img = await loadImage(file)
        images.push(img)
        const b = document.createElement('button')
        b.className = 'thumb'
        b.type = 'button'
        b.dataset.i = String(images.length - 1)
        b.style.backgroundImage = `url(${img.thumb})`
        b.setAttribute('aria-label', `Mostrar ${img.name}`)
        b.addEventListener('click', () => showImage(img))
        const li = document.createElement('li')
        li.append(b)
        thumbs.append(li)
        latest = img
      } catch {
        say(`No pudimos leer ${file.name}. Prueba con JPG, PNG o WebP.`)
      }
    }
    if (latest) await showImage(latest)
  }

  const fileInput = $<HTMLInputElement>('file')
  fileInput.addEventListener('change', async () => {
    await addFiles(Array.from(fileInput.files ?? []))
    fileInput.value = ''
  })

  const drop = $('drop')
  let dragDepth = 0
  window.addEventListener('dragenter', (e) => {
    e.preventDefault()
    dragDepth++
    drop.hidden = false
  })
  window.addEventListener('dragleave', () => {
    if (--dragDepth <= 0) {
      dragDepth = 0
      drop.hidden = true
    }
  })
  window.addEventListener('dragover', (e) => e.preventDefault())
  window.addEventListener('drop', (e) => {
    e.preventDefault()
    dragDepth = 0
    drop.hidden = true
    addFiles(Array.from(e.dataTransfer?.files ?? []))
  })

  $('save').addEventListener('click', async () => {
    const blob = await stage.snapshot()
    if (!blob) return say('No se pudo guardar la imagen.')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `reflejo-${Date.now()}.png`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  })

  const panel = $('panel')
  const settingsBtn = $('settings')
  settingsBtn.addEventListener('click', () => {
    panel.hidden = !panel.hidden
    settingsBtn.setAttribute('aria-expanded', String(!panel.hidden))
  })

  const bind = (key: keyof Settings, format: (v: number) => string) => {
    const input = $<HTMLInputElement>(key)
    const out = $<HTMLOutputElement>(`${key}-out`)
    const apply = () => {
      settings[key] = Number(input.value)
      out.textContent = format(settings[key])
    }
    input.addEventListener('input', apply)
    apply()
  }
  const count = $<HTMLInputElement>('count')
  count.min = '10000'
  count.max = String(MAX_COUNT)
  count.value = String(DEFAULT_COUNT)
  bind('count', (v) => nf.format(v))
  bind('size', (v) => `${v.toFixed(2)}×`)
  bind('relief', (v) => v.toFixed(2))
  bind('smoothing', (v) => `${Math.round(v * 100)} %`)
  bind('scatter', (v) => v.toFixed(2))

  const hud = $('hud')
  setInterval(() => {
    hud.textContent = `${Math.round(stage.fps)} fps · ${nf.format(settings.count)} partículas`
  }, 500)

  if (import.meta.env.DEV) (window as unknown as { reflejo: unknown }).reflejo = { stage, settings }

  refresh()
  stage.show(title)
}

boot()

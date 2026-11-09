import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

// A phone on the local network only gets the camera over HTTPS, so `npm run dev:phone`
// serves with a throwaway certificate. Plain `npm run dev` stays on http://localhost.
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

export default defineConfig({
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  plugins: env.HTTPS ? [basicSsl()] : [],
})

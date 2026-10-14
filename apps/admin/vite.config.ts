import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = process.env.JC_API_ORIGIN ?? 'http://127.0.0.1:8787';

// The admin console runs on its own origin (WebAuthn RP origin http://localhost:5174 in development).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5174, strictPort: true, proxy: { '/api': { target: api } } },
  preview: { port: 5174, strictPort: true, proxy: { '/api': { target: api } } },
  build: { target: 'es2022' },
});

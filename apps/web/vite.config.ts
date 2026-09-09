import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

// Tailwind 4 defines its palette as oklch()/oklab() custom properties. Browsers older than Chrome 111 treat those as
// invalid, so every `background-color: var(--color-slate-950)` silently becomes transparent and the dark warehouse
// mode renders white text on a white page (seen on the handhelds). This plugin rewrites the colors in the built CSS
// to plain hex, which every browser understands. Alpha ("/ 50%") is preserved as 8-digit hex.
function oklchToHex(l: number, c: number, h: number, alpha: number | null): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  return oklabToHex(l, a, b, alpha);
}
function oklabToHex(L: number, a: number, b: number, alpha: number | null): string {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const lin = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s];
  const gamma = (x: number) => {
    const v = Math.min(1, Math.max(0, x));
    return v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
  };
  const hex = (v: number) => Math.round(gamma(v) * 255).toString(16).padStart(2, '0');
  const out = `#${hex(lin[0]!)}${hex(lin[1]!)}${hex(lin[2]!)}`;
  return alpha === null || alpha >= 1 ? out : `${out}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;
}
function num(v: string, percentScale: number): number {
  return v.endsWith('%') ? (parseFloat(v) / 100) * percentScale : parseFloat(v);
}
function legacyColors(css: string): string {
  // keep `color-mix(... , var(--x) ...)` and `oklch(from …)` untouched; only literal oklch()/oklab() values are rewritten
  return css.replace(/\b(oklch|oklab)\(([^()]+)\)/g, (all, fn: string, body: string) => {
    if (/\bfrom\b|var\(/.test(body)) return all;
    const [main, alphaStr] = body.split('/').map((x) => x.trim());
    const parts = main!.split(/\s+/);
    if (parts.length < 3) return all;
    const alpha = alphaStr ? num(alphaStr, 1) : null;
    const L = num(parts[0]!, 1);
    if (fn === 'oklch') return oklchToHex(L, num(parts[1]!, 0.4), parts[2] === 'none' ? 0 : parseFloat(parts[2]!), alpha);
    return oklabToHex(L, num(parts[1]!, 0.4), num(parts[2]!, 0.4), alpha);
  });
}
function legacyColorCss(): Plugin {
  return {
    name: 'wms-legacy-color-css',
    apply: 'build',
    generateBundle(_opts, bundle) {
      for (const f of Object.values(bundle)) {
        if (f.type === 'asset' && f.fileName.endsWith('.css') && typeof f.source === 'string') f.source = legacyColors(f.source);
      }
    },
  };
}

// Dev server proxies /api to the Fastify API so the session cookie is same-origin.
export default defineConfig({
  plugins: [react(), tailwindcss(), legacyColorCss()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.VITE_API_PROXY ?? 'http://localhost:4000',
        changeOrigin: false,
      },
    },
  },
  build: {
    // Handhelds ship older Chrome/WebView builds: keep the JS syntax at ES2019 and let esbuild lower modern CSS colors
    // (oklch/oklab from Tailwind 4) to rgb fallbacks so the dark warehouse mode does not render white-on-white.
    target: ['es2019', 'chrome87', 'safari14'],
    cssTarget: ['chrome87', 'safari14'],
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three', '@react-three/fiber', '@react-three/drei'],
          vendor: ['react', 'react-dom', 'react-router-dom', '@tanstack/react-query'],
        },
      },
    },
  },
});

import { createServer, defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';

type Loader = (path: string) => Promise<Record<string, any>>;
type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function apiMiddleware(load: Loader): Middleware {
  return async (req, res, next) => {
    const m = /^\/api\/([a-z]+)(\?|$)/.exec(req.url ?? '');
    if (!m) return next();
    try {
      const mod = await load(`/api/${m[1]}.ts`);
      const handler = mod[req.method ?? 'GET'];
      if (!handler) {
        res.statusCode = 405;
        return res.end('method not allowed');
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const request = new Request(`http://localhost${req.url}`, {
        method: req.method,
        headers: req.headers as Record<string, string>,
        body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
      });
      const response: Response = await handler(request);
      res.statusCode = response.status;
      response.headers.forEach((v, k) => res.setHeader(k, v));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (e) {
      console.error(e);
      res.statusCode = 500;
      res.end(String(e));
    }
  };
}

/** Serve api/*.ts (Vercel-style Web handlers) from the Vite dev server, and from `vite preview`. */
function devApi(): Plugin {
  return {
    name: 'apexkart-dev-api',
    configureServer(server) {
      server.middlewares.use(apiMiddleware((p) => server.ssrLoadModule(p)));
    },
    async configurePreviewServer(server) {
      // The built site has no API; load the handlers through a dev server in middleware mode.
      const vite = await createServer({ root: server.config.root, configFile: false, server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'error' });
      server.middlewares.use(apiMiddleware((p) => vite.ssrLoadModule(p)));
    },
  };
}

export default defineConfig({
  plugins: [devApi()],
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1200,
    // pad.html is the phone wheel: its own small page, so a phone doesn't load the game.
    rollupOptions: { input: { main: 'index.html', pad: 'pad.html' } },
  },
});

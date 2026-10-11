import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { BASE_PATH, JOIN_PATH_PREFIX } from '@brawl/protocol';

interface Asset {
  body: Buffer;
  gzip: Buffer | null;
  type: string;
  /** Weak etag over the identity body. */
  etag: string;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // Browsers refuse to execute a module served with a non-JS MIME type, and
  // the failure is silent — the page just renders nothing.
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
};

/**
 * Tiny static server over the build output.
 *
 * Everything is read once at startup and held in memory with its gzip
 * variant precomputed at build time — no per-request compression, because
 * ten phones hitting this simultaneously on a CPU-limited box is exactly the
 * moment you do not want to be gzipping.
 */
export class StaticFiles {
  private readonly assets = new Map<string, Asset>();

  constructor(private readonly root: string) {}

  private async load(name: string): Promise<Asset | null> {
    const cached = this.assets.get(name);
    if (cached) return cached;

    const file = path.join(this.root, name);
    if (!file.startsWith(this.root) || !existsSync(file)) return null;

    const body = await readFile(file);
    const gzPath = `${file}.gz`;
    const gzip = existsSync(gzPath) ? await readFile(gzPath) : null;

    const asset: Asset = {
      body,
      gzip,
      type: MIME[path.extname(file)] ?? 'application/octet-stream',
      // Content is immutable for a process lifetime; size+mtime-free etag is fine.
      etag: `W/"${body.byteLength.toString(16)}-${hash(body)}"`,
    };
    this.assets.set(name, asset);
    return asset;
  }

  async serve(
    req: IncomingMessage,
    res: ServerResponse,
    name: string,
    cache: 'immutable' | 'no-store',
  ): Promise<boolean> {
    const asset = await this.load(name);
    if (!asset) return false;

    res.setHeader('Content-Type', asset.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader(
      'Cache-Control',
      cache === 'immutable' ? 'public, max-age=31536000, immutable' : 'no-store',
    );
    res.setHeader('ETag', asset.etag);

    if (req.headers['if-none-match'] === asset.etag) {
      res.writeHead(304).end();
      return true;
    }

    const wantsGzip = (req.headers['accept-encoding'] ?? '').toString().includes('gzip');
    if (wantsGzip && asset.gzip) {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : asset.gzip);
    } else {
      res.writeHead(200).end(req.method === 'HEAD' ? undefined : asset.body);
    }
    return true;
  }
}

function hash(buf: Buffer): string {
  // FNV-1a; only needs to change when the bytes change.
  let h = 0x811c9dc5;
  for (let i = 0; i < buf.length; i++) {
    h ^= buf[i]!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
}

/** Map a request path to an asset name, or null for 404. */
export function routeStatic(pathname: string): { name: string; cache: 'immutable' | 'no-store' } | null {
  // Normalise: /brawl-games and /brawl-games/ both mean the host screen.
  const rel = pathname === BASE_PATH ? '/' : pathname.slice(BASE_PATH.length) || '/';

  if (rel === '/' || rel === '/host' || rel === '/host/') {
    return { name: 'host.html', cache: 'no-store' };
  }

  // /j/ABCD -> the controller page. The code is read from the URL by its JS,
  // so every room shares one cacheable document.
  if (pathname.startsWith(JOIN_PATH_PREFIX)) {
    return { name: 'controller.html', cache: 'no-store' };
  }

  // Visual prototypes: a flat folder of hand-written pages, served as-is.
  // Never cached, because the whole point is iterating on how they look.
  if (rel.startsWith('/proto')) {
    const file = rel === '/proto' || rel === '/proto/' ? 'index.html' : rel.slice('/proto/'.length);
    // One level of nesting is allowed for vendored module trees (jsm/...),
    // but never a traversal.
    if (!file || file.includes('..')) return null;
    return { name: `proto/${file}`, cache: 'no-store' };
  }

  if (rel.startsWith('/assets/')) {
    const file = rel.slice('/assets/'.length);
    if (!file || file.includes('..') || file.includes('/')) return null;
    // Only content-hashed chunks may be cached forever. The entry bundle has a
    // STABLE filename, so marking it immutable pins every host screen to
    // whatever build it first loaded — a deploy would never reach the TV, and
    // the symptom (fresh HTML, stale behaviour) is baffling to debug.
    const hashed = /^(chunk|host)-[A-Z0-9]+\.js$/i.test(file);
    return { name: file, cache: hashed ? 'immutable' : 'no-store' };
  }

  return null;
}

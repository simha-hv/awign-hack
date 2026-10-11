import type { IncomingMessage } from 'node:http';

const firstHeader = (value: string | string[] | undefined): string | undefined => {
  if (Array.isArray(value)) return value[0];
  return value;
};

/** Host header values that mean "someone reached us directly, not via nginx". */
function isDirectHost(host: string): boolean {
  const name = host.split(':')[0] ?? '';
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true;
  // Bare IPv4 (LAN dev) or bracketed IPv6.
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(name) || name.startsWith('[');
}

/**
 * The absolute origin to embed in the QR code.
 *
 * Precedence:
 *   1. PUBLIC_ORIGIN env — always wins, set it in production.
 *   2. X-Forwarded-Proto, if the proxy sets it.
 *   3. Inference: a real domain name in the Host header only reaches us
 *      through nginx, and that vhost is TLS-only, so assume https. A bare IP
 *      or localhost means direct LAN access, so http.
 *
 * The nginx block for /brawl-games/ forwards `Host` but not
 * `X-Forwarded-Proto`, which is why rule 3 exists. Adding
 * `proxy_set_header X-Forwarded-Proto $scheme;` there would make rule 2 do
 * the work instead — see the README.
 */
export function originFor(req: IncomingMessage): string {
  const configured = process.env.PUBLIC_ORIGIN?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = firstHeader(req.headers.host) ?? `localhost:${process.env.PORT ?? 1099}`;
  const forwardedProto = firstHeader(req.headers['x-forwarded-proto'])?.split(',')[0]?.trim();

  const proto = forwardedProto ?? (isDirectHost(host) ? 'http' : 'https');
  return `${proto}://${host}`;
}

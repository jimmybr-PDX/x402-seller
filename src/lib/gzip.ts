/**
 * Gzip text/JSON/HTML responses when the client sends Accept-Encoding: gzip.
 *
 * Hooks res.write / res.end so unpaid x402 402 challenges are compressed too.
 * Cloudflare only gzip-compresses 2xx, and @x402/express answers 402 via
 * res.json / res.send after the payment middleware, so a late or status-gated
 * compressor would miss them. PAYMENT-REQUIRED, PAYMENT-RESPONSE, and X-PAYMENT
 * headers are left untouched. Clients that omit gzip get the original body.
 */
import { gzipSync } from "node:zlib";
import type { Request, Response, NextFunction } from "express";

const MIN_BYTES = 256;
const COMPRESSIBLE =
  /^(?:text\/|application\/(?:json|javascript|xml|problem\+json|ld\+json|xhtml\+xml|x-www-form-urlencoded|manifest\+json|rss\+xml|atom\+xml)|image\/svg\+xml|application\/xml)/i;

export function acceptsGzip(header: string | undefined): boolean {
  if (!header) return false;
  for (const part of header.split(",")) {
    const bits = part.trim().split(";").map((s) => s.trim());
    const coding = (bits[0] ?? "").toLowerCase();
    if (coding !== "gzip" && coding !== "*") continue;
    const q = bits.find((p) => p.toLowerCase().startsWith("q="));
    const qv = q ? Number(q.slice(2)) : 1;
    if (qv > 0) return true;
  }
  return false;
}

function toBuffer(chunk: unknown, encoding?: BufferEncoding | string): Buffer {
  if (chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  if (typeof chunk === "string") return Buffer.from(chunk, (encoding as BufferEncoding) || "utf8");
  return Buffer.from(String(chunk));
}

export function gzipMiddleware(req: Request, res: Response, next: NextFunction): void {
  res.vary("Accept-Encoding");
  if (req.method === "HEAD" || !acceptsGzip(String(req.headers["accept-encoding"] ?? ""))) {
    next();
    return;
  }

  const chunks: Buffer[] = [];
  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);

  res.write = function writePatched(chunk?: any, encoding?: any, cb?: any) {
    if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (chunk != null && chunk !== "") chunks.push(toBuffer(chunk, encoding));
    if (typeof cb === "function") cb();
    return true;
  } as typeof res.write;

  res.end = function endPatched(chunk?: any, encoding?: any, cb?: any) {
    if (typeof chunk === "function") {
      cb = chunk;
      chunk = undefined;
      encoding = undefined;
    } else if (typeof encoding === "function") {
      cb = encoding;
      encoding = undefined;
    }
    if (chunk != null && chunk !== "") chunks.push(toBuffer(chunk, encoding));

    res.write = originalWrite as typeof res.write;
    res.end = originalEnd as typeof res.end;

    const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
    const type = String(res.getHeader("content-type") ?? "");
    const already = res.getHeader("content-encoding");
    const status = res.statusCode || 200;
    const skip = already || status === 204 || status === 304 || body.length < MIN_BYTES || !COMPRESSIBLE.test(type);

    if (skip) {
      return typeof cb === "function" ? originalEnd(body, cb) : originalEnd(body);
    }

    const gz = gzipSync(body, { level: 6 });
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Content-Length", String(gz.length));
    return typeof cb === "function" ? originalEnd(gz, cb) : originalEnd(gz);
  } as typeof res.end;

  next();
}

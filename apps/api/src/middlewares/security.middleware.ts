import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

type RateLimitOptions = {
  windowMs: number;
  limit: number;
  message: string;
};

type Bucket = { count: number; resetAt: number };

function clientKey(req: Request) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

export function requestId(req: Request, res: Response, next: NextFunction) {
  const incoming = req.get("x-request-id");
  const id = incoming && /^[A-Za-z0-9._:-]{8,100}$/.test(incoming)
    ? incoming
    : crypto.randomUUID();
  res.setHeader("X-Request-Id", id);
  next();
}

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, Bucket>();
  let lastCleanup = 0;

  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const key = clientKey(req);
    const current = buckets.get(key);
    const bucket = !current || current.resetAt <= now
      ? { count: 0, resetAt: now + options.windowMs }
      : current;
    bucket.count += 1;
    buckets.set(key, bucket);

    if (now - lastCleanup > options.windowMs) {
      lastCleanup = now;
      for (const [entryKey, entry] of buckets) {
        if (entry.resetAt <= now) buckets.delete(entryKey);
      }
    }

    res.setHeader("RateLimit-Limit", options.limit);
    res.setHeader("RateLimit-Remaining", Math.max(0, options.limit - bucket.count));
    res.setHeader("RateLimit-Reset", Math.ceil(bucket.resetAt / 1000));

    if (bucket.count > options.limit) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)));
      res.status(429).json({ message: options.message });
      return;
    }
    next();
  };
}

export const apiRateLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: 300,
  message: "Muitas requisições. Aguarde alguns segundos e tente novamente."
});

export const loginRateLimiter = createRateLimiter({
  windowMs: 15 * 60_000,
  limit: 12,
  message: "Muitas tentativas de acesso. Aguarde alguns minutos e tente novamente."
});

export const uploadRateLimiter = createRateLimiter({
  windowMs: 60_000,
  limit: 50,
  message: "Muitos envios em pouco tempo. Aguarde antes de enviar novos espelhos."
});

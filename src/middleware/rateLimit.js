/**
 * Simple in-memory rate limiter (no Redis needed for single-instance)
 * For multi-instance deploys, replace with express-rate-limit + Redis store.
 */

const buckets = new Map()

/**
 * Create a rate-limit middleware.
 * @param {object} opts
 * @param {number} opts.windowMs   - Time window in ms (default: 60_000)
 * @param {number} opts.max        - Max requests per window (default: 60)
 * @param {string} [opts.message]  - Error message
 * @param {function} [opts.keyFn]  - Custom key function (req) => string
 */
function rateLimit({ windowMs = 60_000, max = 60, message, keyFn } = {}) {
  const msg = message || `Too many requests. Try again in ${Math.ceil(windowMs / 1000)}s.`

  return (req, res, next) => {
    const key = keyFn ? keyFn(req) : (req.ip || 'global')
    const now = Date.now()

    if (!buckets.has(key)) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    const bucket = buckets.get(key)

    // Reset expired bucket
    if (now > bucket.resetAt) {
      bucket.count = 1
      bucket.resetAt = now + windowMs
      return next()
    }

    bucket.count++
    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000)
      res.set('Retry-After', retryAfter)
      return res.status(429).json({ error: msg, retryAfter })
    }

    next()
  }
}

// Cleanup old buckets every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [key, bucket] of buckets.entries()) {
    if (now > bucket.resetAt) buckets.delete(key)
  }
}, 5 * 60_000)

// Pre-configured limiters
const authLimiter   = rateLimit({ windowMs: 60_000, max: 100,  message: 'Muitas tentativas de login. Aguarde 1 minuto.' })
const uploadLimiter = rateLimit({ windowMs: 60_000,       max: 30,  message: 'Muitos uploads. Aguarde 1 minuto.' })
const apiLimiter    = rateLimit({ windowMs: 60_000,       max: 120 })

module.exports = { rateLimit, authLimiter, uploadLimiter, apiLimiter }

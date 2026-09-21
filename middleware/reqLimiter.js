const { rateLimit } = require('express-rate-limit')
// only 20 req in 10 minutes
const limiter = rateLimit({
  windowMs: 10 * 60000, // 10 minutes
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { msg: 'Too many attempts, please try again later' },
})

module.exports = limiter

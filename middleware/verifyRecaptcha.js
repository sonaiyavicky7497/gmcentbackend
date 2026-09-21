const verifyRecaptcha = async (req, res, next) => {
  console.log('='.repeat(50))
  console.log('🔐 reCAPTCHA v3 (invisible) VERIFICATION')
  console.log('Time:', new Date().toISOString())
  console.log('URL:', req.url)
  console.log('='.repeat(50))

  // For development testing - bypass option
  const isDevelopment = process.env.NODE_ENV !== 'production'
  const recaptchaDisabled = process.env.RECAPTCHA_DISABLED === 'true'

  if (isDevelopment && recaptchaDisabled) {
    console.log('⚠️ DEVELOPMENT MODE: Skipping reCAPTCHA verification')
    req.recaptchaData = {
      success: true,
      hostname: 'localhost',
      timestamp: new Date().toISOString(),
      bypassed: true,
    }
    return next()
  }

  const { recaptchaToken } = req.body

  console.log('Token present:', !!recaptchaToken)
  console.log('Token sample:', recaptchaToken ? recaptchaToken.substring(0, 30) + '...' : 'None')
  console.log('Token length:', recaptchaToken ? recaptchaToken.length : 0)

  if (!recaptchaToken) {
    console.log('❌ No reCAPTCHA token provided')
    return res.status(400).json({
      status: false,
      msg: 'Please complete the security verification (reCAPTCHA).',
    })
  }

  // Use TEST secret for development (always works with localhost)
  let secretKey = process.env.GOOGLE_RECAPTCHA_SECRET_KEY

  // If no secret key, use test secret
  if (!secretKey) {
    console.log('⚠️ No secret key found, using test secret')
    secretKey = '6LeIxAcTAAAAAGG-vFI1TnRWxMZNFuojJ4WifJWe' // Test secret for v2 checkbox
  }

  console.log('Using secret:', secretKey.substring(0, 15) + '...')

  // v3 configuration
  const minScore = parseFloat(process.env.RECAPTCHA_MIN_SCORE) || 0.5
  const expectedAction = process.env.RECAPTCHA_EXPECTED_ACTION || ''

  try {
    const verificationUrl = 'https://www.google.com/recaptcha/api/siteverify'

    const params = new URLSearchParams()
    params.append('secret', secretKey)
    params.append('response', recaptchaToken)

    // For test keys, Google doesn't require IP
    if (!secretKey.includes('6LeIxAcT')) {
      // Not a test key
      const clientIP = req.ip || req.headers['x-forwarded-for']?.split(',')[0]?.trim() || ''
      if (clientIP) {
        params.append('remoteip', clientIP)
        console.log('Client IP:', clientIP)
      }
    }

    console.log('📤 Verifying with Google...')

    const response = await fetch(verificationUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: params.toString(),
      timeout: 10000,
    })

    console.log('Google response status:', response.status)

    if (!response.ok) {
      const text = await response.text()
      console.error('Google API error response:', text)
      throw new Error(`Google API returned ${response.status}: ${text}`)
    }

    const data = await response.json()

    console.log('📥 Google Response:')
    console.log('  Success:', data.success)
    console.log('  Hostname:', data.hostname)
    console.log('  Errors:', data['error-codes'] || 'None')
    console.log('  Challenge TS:', data.challenge_ts)

    if (!data.success) {
      const errorCodes = data['error-codes'] || []
      console.error('❌ reCAPTCHA verification failed:', errorCodes)

      let errorMsg = 'Security verification failed.'

      if (errorCodes.includes('invalid-input-secret')) {
        errorMsg = 'Server configuration error (invalid secret). Please verify your server reCAPTCHA secret.'
      } else if (errorCodes.includes('invalid-input-response')) {
        errorMsg = 'Invalid verification token. Possible site key / secret mismatch or token tampering.'
      } else if (errorCodes.includes('timeout-or-duplicate')) {
        errorMsg = 'Verification expired. Please complete the reCAPTCHA again.'
      } else if (errorCodes.includes('missing-input-response')) {
        errorMsg = 'No verification token received. Please complete the reCAPTCHA.'
      } else if (errorCodes.includes('bad-request')) {
        errorMsg = 'Bad request to verification service.'
      }

      // Include Google response in development to aid debugging
      const devPayload = isDevelopment ? { google: data } : undefined

      return res.status(400).json(
        Object.assign(
          {
            status: false,
            msg: errorMsg,
            errorCodes: errorCodes,
          },
          devPayload
        )
      )
    }

    // v3: check score threshold if present
    if (typeof data.score === 'number') {
      if (data.score < minScore) {
        console.error('❌ reCAPTCHA low score:', data.score)
        return res.status(400).json({ status: false, msg: 'Low reCAPTCHA score. Please try again.' })
      }
    }

    // If expectedAction is set, validate it
    if (expectedAction && data.action && data.action !== expectedAction) {
      console.error('❌ reCAPTCHA action mismatch:', data.action, 'expected:', expectedAction)
      return res.status(400).json({ status: false, msg: 'reCAPTCHA action mismatch.' })
    }

    console.log('✅ reCAPTCHA verified successfully!')

    // Store verification data (including score/action for downstream use)
    req.recaptchaData = {
      success: data.success,
      hostname: data.hostname,
      timestamp: data.challenge_ts,
      score: data.score,
      action: data.action,
    }

    console.log('='.repeat(50))
    next()
  } catch (error) {
    console.error('❌ Verification error:', error.message)
    console.error('Stack:', error.stack)

    // In development, allow bypass for testing
    if (isDevelopment) {
      console.warn('⚠️ Allowing request in development despite error')
      req.recaptchaData = {
        success: true,
        hostname: 'localhost',
        timestamp: new Date().toISOString(),
        errorBypassed: true,
        error: error.message,
      }
      return next()
    }

    res.status(500).json({
      status: false,
      msg: 'Security verification failed. Please try again.',
      error: isDevelopment ? error.message : undefined,
    })
  }
}

module.exports = verifyRecaptcha

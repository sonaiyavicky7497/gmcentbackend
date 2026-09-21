const express = require('express')
const app = express()
app.set('trust proxy', 1) // trust first proxy for secure cookies behind load balancers
require('dotenv').config()
const cors = require('cors')
const { FRONTEND_URI, PORT, OWNERPANEL_URI } = process.env

const { paymentWebhook } = require('./controller/admin/transact.controller.js')
app.post('/webhook', express.raw({ type: 'application/json' }), paymentWebhook)
const corsOptions = {
  origin: function (origin, callback) {
    const allowedOrigins = [
      FRONTEND_URI,
      OWNERPANEL_URI,
      'http://192.168.0.239:1002',
      'http://127.0.0.1:3000',
      'http://localhost:1002',
      'http://localhost:3000',
    ]
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true)
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      console.log('Blocked CORS origin:', origin)
      callback(new Error(`Not allowed by CORS: ${origin}`))
    }
  },
  credentials: true,
  optionsSuccessStatus: 200,
}

app.use(cors(corsOptions))

// Add security headers but configure them properly for popups
app.use((req, res, next) => {
  // Don't set COOP/COEP for Google OAuth endpoints to allow popups
  if (
    req.path.includes('/api/admin/googleLogin') ||
    req.path.includes('/api/admin/drive/oauth') ||
    req.path.includes('/api/auth/callback/google')
  ) {
    // Allow cross-origin popups for Google OAuth
    res.setHeader('Cross-Origin-Opener-Policy', 'unsafe-none')
    res.setHeader('Cross-Origin-Embedder-Policy', 'unsafe-none')
  } else {
    // Default security headers for other endpoints
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups')
    res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  }

  // Common security headers
  res.setHeader('X-Frame-Options', 'SAMEORIGIN')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')

  next()
})
app.use(express.json({ limit: '100mb' }))
app.use(express.urlencoded({ limit: '100mb', extended: true }))

app.get('/', (req, res) => res.send('GPS map camera backend'))

// Health check endpoint for deployments and load balancers
app.get('/health', (req, res) => {
  const pkg = (() => {
    try {
      return require('./package.json')
    } catch (e) {
      return {}
    }
  })()
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: Date.now(),
    version: pkg.version || null,
  })
})

const authRoute = require('./routes/admin/auth.routes.js')
const projectRoute = require('./routes/admin/projectInfo.routes.js')
const transactRoute = require('./routes/admin/transact.routes.js')
const seatRoute = require('./routes/admin/seat.routes.js')
const settingRoute = require('./routes/admin/settings.routes.js')
const imageCodeAdminRoute = require('./routes/admin/imageCode.routes.js')
const enterprisePhotoCodesRoute = require('./routes/enterprise/photoCodes.routes.js')
const driveRoute = require('./routes/admin/drive.routes.js')
const { handleOAuthCallback } = require('./controller/admin/drive.controller.js')

const authRouteForMobile = require('./routes/mobile/auth.routes.js')
const projectInfoFormMobile = require('./routes/mobile/projectInfo.routes.js')
const imageCodeMobileRoute = require('./routes/mobile/imageCode.routes.js')
const driveMobileRoute = require('./routes/mobile/drive.routes.js')

const ownerAuth = require('./routes/owner/auth.routes.js')
const companiesRoute = require('./routes/owner/companies.routes.js')
const ownerPhotoCodesRoute = require('./routes/owner/photoCodes.routes.js')

const { startCronJobs } = require('./cron/index.js')
const ownerTransactRoute = require('./routes/owner/transact.routes.js')
const ownerUserRoute = require('./routes/owner/user.routes.js')
const reportRoute = require('./routes/owner/report.routes.js')

app.use('/api/admin', authRoute)
app.use('/api/admin', projectRoute)
app.use('/api/admin', transactRoute)
app.use('/api/admin', seatRoute)
app.use('/api/admin', settingRoute)
app.use('/api/admin', imageCodeAdminRoute)
app.use('/api/admin/drive', driveRoute)
app.get('/api/auth/callback/google', handleOAuthCallback)
app.use('/api/enterprise', enterprisePhotoCodesRoute)

app.use('/api/mobile', authRouteForMobile)
app.use('/api/mobile', projectInfoFormMobile)
app.use('/api/mobile', imageCodeMobileRoute)
app.use('/api/mobile/drive', driveMobileRoute)

app.use('/api/owner', ownerAuth)
app.use('/api/owner', companiesRoute)
app.use('/api/owner', ownerPhotoCodesRoute)
app.use('/api/owner', ownerTransactRoute)
app.use('/api/owner', ownerUserRoute)
app.use('/api/reports', reportRoute)

startCronJobs()

app.use('/uploads', express.static(process.cwd() + '/uploads'))
app.use('/public', express.static(process.cwd() + '/public'))

app.listen(PORT, '0.0.0.0', () => console.log(`Server is running on port:`, PORT))

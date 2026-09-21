const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const nodemailer = require('nodemailer')
const path = require('path')
const hbs = require('nodemailer-express-handlebars')
const planList = require('../utils/trade/plan.json')
const moment = require('moment')
const Bull = require('bull')
const userAgent = require('express-useragent')
const http = require('http')
const tempEmailDomains = require('./tempEmailDomains')

// Initialize email queue with Redis
// If Redis is not available, we'll fallback to direct email sending
let emailQueue = null
let redisAvailable = false

try {
  const redisHost = process.env.REDIS_HOST || '127.0.0.1'
  const redisPort = process.env.REDIS_PORT || 6379
  emailQueue = new Bull('email-queue', {
    redis: {
      host: redisHost,
      port: redisPort,
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000)
        return delay
      },
      maxRetriesPerRequest: 3,
    },
  })

  // Test Redis connection
  emailQueue.client.on('connect', () => {
    redisAvailable = true
    console.log('✅ Redis connected successfully for email queue')
  })

  emailQueue.client.on('error', (err) => {
    redisAvailable = false
    // console.warn('⚠️ Redis connection error:', err.message)
    // console.warn('⚠️ Falling back to direct email sending (without queue)')
  })
} catch (error) {
  console.warn('⚠️ Redis initialization failed:', error.message)
  console.warn('⚠️ Email will be sent directly without queue')
  redisAvailable = false
}

const enc = (textToEncrypt, secret) => {
  const iv = secret.substr(0, 16)
  const encrypt = crypto.createCipheriv('aes-256-ctr', secret, iv)
  return encrypt.update(textToEncrypt, 'utf8', 'base64') + encrypt.final('base64')
}

const dec = (encryptedMessage, secret) => {
  const iv = secret.substr(0, 16)
  const decrypt = crypto.createDecipheriv('aes-256-ctr', secret, iv)
  return decrypt.update(encryptedMessage, 'base64', 'utf8') + decrypt.final('utf8')
}

const isValidUrl = (url) => {
  const re =
    /((([A-Za-z]{3,9}:(?:\/\/)?)(?:[-;:&=\+\$,\w]+@)?[A-Za-z0-9.-]+|(?:www.|[-;:&=\+\$,\w]+@)[A-Za-z0-9.-]+)((?:\/[\+~%\/.\w-_]*)?\??(?:[-\+=&;%@.\w_]*)#?(?:[\w]*))?)/
  return re.test(url)
}

const imageURL = (url, type = '') => {
  if (!url) {
    return null
  }

  // If it's already a full URL (like Google profile picture), return as is
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url
  }

  // For local images, prepend the file source
  const fileSource = process.env.FILE_SOURCE || 'http://192.168.0.239:1003/uploads/' || 'http://localhost:1003/uploads/'
  return `${fileSource}${type ? type + '/' : ''}${url}`
}

const generateUniqueId = () => {
  const uniqueId = uuidv4()
  return uniqueId.replace(/-/g, '').slice(0, 8)
}

const sendMail = async (to, subject, template, context = {}) => {
  return new Promise((resolve, reject) => {
    // Validate email configuration
    if (!process.env.MAIL_SENDBY || !process.env.APP_PASSWORD) {
      const error = new Error('Email configuration missing. Please set MAIL_SENDBY and APP_PASSWORD environment variables.')
      console.error('❌ Email configuration error:', error.message)
      reject(error)
      return
    }

    const transporter = nodemailer.createTransport({
      host: 'gpsmapcamera.com',
      port: 465,
      secure: true,
      auth: {
        user: process.env.MAIL_SENDBY,
        pass: process.env.APP_PASSWORD,
      },
      // Add connection timeout
      connectionTimeout: 10000, // 10 seconds
      greetingTimeout: 10000,
      socketTimeout: 10000,
    })

    const handlebarOptions = {
      viewEngine: {
        extName: '.hbs',
        partialsDir: path.resolve('./emailView'),
        defaultLayout: false,
      },
      viewPath: path.resolve('./emailView'),
      extName: '.hbs',
    }
    transporter.use('compile', hbs(handlebarOptions))

    const mailOptions = {
      from: `GPS Map Camera ENT <${process.env.MAIL_SENDBY}>`,
      to,
      subject,
      template,
      context,
    }

    console.log(`📧 Attempting to send email to: ${to}`)
    console.log(`📧 Subject: ${subject}`)
    console.log(`📧 Template: ${template}`)

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error('❌ Error in email send:', error.message)
        console.error('Error code:', error.code)
        console.error('Error command:', error.command)
        reject(error)
        return
      }
      console.log('✅ Email sent successfully!')
      console.log('Message ID:', info.messageId)
      console.log('Response:', info.response)
      resolve(info)
    })
  })
}

// Process email queue jobs (only if Redis is available)
if (emailQueue) {
  emailQueue.process(async (job, done) => {
    const { to, subject, template, context } = job.data
    console.log(`📬 Processing email job for: ${to}`)
    try {
      const result = await sendMail(to, subject, template, context)
      console.log(`✅ Email job completed successfully for: ${to}`)
      done(null, result)
    } catch (error) {
      console.error(`❌ Email job failed for: ${to}`, error.message)
      done(new Error(`Failed to send email: ${error.message}`))
    }
  })
}

const queueMail = async (to, subject, template, context = {}) => {
  // If Redis is not available, send email directly
  if (!redisAvailable || !emailQueue) {
    console.log('📧 Sending email directly (Redis queue not available)')
    return await sendMail(to, subject, template, context)
  }

  try {
    // Add job to queue with retry options
    const job = await emailQueue.add(
      { to, subject, template, context },
      {
        attempts: 3,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: false,
      },
    )

    console.log(`📬 Email job added to queue. Job ID: ${job.id}, To: ${to}`)

    // Wait for job to complete (with timeout)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.warn('⚠️ Email job timeout, sending directly...')
        // Fallback to direct sending if queue times out
        sendMail(to, subject, template, context).then(resolve).catch(reject)
      }, 30000) // 30 seconds timeout

      job
        .finished()
        .then((result) => {
          clearTimeout(timeout)
          console.log(`✅ Email job finished successfully. Job ID: ${job.id}`)
          resolve(result)
        })
        .catch((error) => {
          clearTimeout(timeout)
          console.error(`❌ Email job failed. Job ID: ${job.id}`, error.message)
          console.log('🔄 Falling back to direct email sending...')
          // Fallback to direct sending
          sendMail(to, subject, template, context).then(resolve).catch(reject)
        })
    })
  } catch (error) {
    console.error('❌ Error adding email to queue:', error.message)
    console.log('🔄 Falling back to direct email sending...')
    // Fallback to direct sending
    return await sendMail(to, subject, template, context)
  }
}

const isValidPassword = (password) => {
  if (password.length < 8) {
    return 'Password length should be at least 8 characters'
  }
  if (!/[a-z]/.test(password)) {
    return 'Password should contain at least one lowercase letter'
  }
  if (!/[A-Z]/.test(password)) {
    return 'Password should contain at least one uppercase letter'
  }

  if (!/[0-9]/.test(password)) {
    return 'Password should contain at least one digit'
  }

  if (!/[!@#$%^&*]/.test(password)) {
    return 'Password should contain at least one special character'
  }

  if (password.includes(' ')) {
    return 'Password should not contain space'
  }

  return true
}

const getPlanByNameAndDuration = (name, duration) => {
  return planList.find((plan) => plan.name === name && plan.billing === duration) || null
}

const getPlanInfo = (planName) => {
  return planList.find((plan) => plan.name === planName) || null
}

const isValidEmail = (email) => {
  // allow uppercase letters as well; regex is case-insensitive now
  const emailRegex = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i
  return emailRegex.test(email)
}

const isTempEmail = (email) => {
  if (!email) return false
  const domain = email.split('@')[1]
  return tempEmailDomains.has(domain?.toLowerCase())
}

const generateId = () => {
  const characters = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'
  let id = ''
  for (let i = 0; i < 7; i++) {
    const randomIndex = Math.floor(Math.random() * characters.length)
    id += characters[randomIndex]
  }
  return id
}

const dateAfterYear = (date = Math.round(Date.now() / 1000)) => {
  const secondsInDay = 86400
  return Number(date) + 365 * secondsInDay
}

const getDaysDifference = (timestamp1, timestamp2) => {
  const date1 = new Date(timestamp1 * 1000)
  const date2 = new Date(timestamp2 * 1000)

  const differenceInTime = Math.max(0, date2 - date1)

  const differenceInDays = Math.floor(differenceInTime / (1000 * 60 * 60 * 24))

  return differenceInDays
}

const isValidMobile = (mobile) => {
  const re = /^[0-9]{8,12}$/
  return re.test(mobile)
}

const dateConverter = (date, type = 'DD/MM/YYYY') => {
  return moment(new Date(date * 1000)).format(type)
}
const now = () => Math.floor(Date.now() / 1000)

const getIpAddress = () => {
  return new Promise((resolve, reject) => {
    http.get({ host: 'api.ipify.org', port: 80, path: '/' }, function (resp) {
      let ip = ''
      resp.on('data', (ipAddress) => {
        ip += ipAddress.toString()
      })
      resp.on('end', () => {
        resolve(ip)
      })
      resp.on('error', (err) => {
        reject(err)
      })
    })
  })
}

const getClientDetails = async (req) => {
  const userAgentInfo = userAgent.parse(req.headers['user-agent'])
  const browser = userAgentInfo.browser
  const os = userAgentInfo.os
  const date = dateConverter(now(), 'Do MMMM YYYY, h:mm:ss a')
  let location = 'Unknown'
  let timezone = 'Unknown'

  const ip = await getIpAddress()
  try {
    let response = await fetch(`http://ip-api.com/json/${ip}`)
    response = await response.json()
    const { city, region, country } = response
    if (response.status === 'success') {
      timezone = response.timezone
      location = `${city}, ${region}, ${country}`
    }
  } catch (err) {
    console.error('Error fetching location:', err.message)
  }
  return { date: `${date} (${timezone})`, browser, os, location, ip }
}

/**
 * Calculate license statistics for a company
 * @param {Object} company - Company object with seatPurchased, seatCapacity, and plan info
 * @param {Number} planTotalSeats - Total seats from the plan (optional, will be calculated if not provided)
 * @returns {Object} License statistics
 */
const calculateLicenseStats = (company, planInfo = null) => {
  if (!planInfo) {
    planInfo = getPlanInfo(company.plan)
  }

  // Total seats from the plan
  const totalSeatsFromPlan = planInfo ? planInfo.seat : 0

  // Current used seats
  const usedSeat = company.usedSeat !== undefined ? company.usedSeat : company.seatPurchased || 0
  const remainingSeat = company.remainingSeat !== undefined ? company.remainingSeat : company.seatCapacity || 0
  const totalSeat = company.totalSeat !== undefined ? company.totalSeat : totalSeatsFromPlan || usedSeat + remainingSeat

  // Legacy mappings for backwards compatibility
  const seatPurchased = usedSeat
  const seatCapacity = remainingSeat
  const totalSeats = totalSeat
  const totalLicenses = totalSeat
  const usedLicenses = usedSeat
  const remainingLicenses = remainingSeat

  // Additional check: used + remaining should equal total
  const calculatedTotal = usedSeat + remainingSeat

  return {
    totalSeat: totalSeat,
    usedSeat: usedSeat,
    remainingSeat: remainingSeat,
    totalPlanSeats: totalSeats, // Total from plan
    usedLicenses: usedLicenses, // Currently used (seatPurchased)
    remainingLicenses: remainingLicenses, // Available (seatCapacity)
    seatPurchased: seatPurchased,
    seatCapacity: seatCapacity,
    totalLicenses: totalLicenses,
    calculatedTotal: calculatedTotal,
    isConsistent: calculatedTotal === totalSeats,
  }
}

/**
 * Validate if a company can add new users
 * @param {Object} company - Company object
 * @param {Boolean} checkExpiry - Whether to check plan expiry
 * @returns {Object} Validation result
 */
const validateLicenseAvailability = (company, checkExpiry = true) => {
  const nowTime = Math.floor(Date.now() / 1000)

  if (!company.plan) {
    return {
      canAdd: false,
      reason: 'No active plan found. Please purchase a plan first.',
      code: 'NO_PLAN',
    }
  }

  if (checkExpiry && company.expiredAt < nowTime) {
    return {
      canAdd: false,
      reason: 'Your plan has expired. Please renew your plan to add users.',
      code: 'PLAN_EXPIRED',
    }
  }

  // Get plan info to know total seats
  const planInfo = getPlanInfo(company.plan)
  const stats = calculateLicenseStats(company, planInfo)

  if (stats.remainingLicenses <= 0) {
    return {
      canAdd: false,
      reason: 'No available licenses. Please upgrade your plan to add more users.',
      code: 'NO_SEATS_AVAILABLE',
    }
  }

  return {
    canAdd: true,
    remaining: stats.remainingSeat,
    used: stats.usedSeat,
    total: stats.totalSeat,
    remainingSeat: stats.remainingSeat,
    usedSeat: stats.usedSeat,
    totalSeat: stats.totalSeat,
    remainingLicenses: stats.remainingSeat,
    usedLicenses: stats.usedSeat,
    totalPlanSeats: stats.totalSeat,
  }
}

module.exports = {
  isValidEmail,
  isTempEmail,
  isValidMobile,
  enc,
  dec,
  imageURL,
  isValidUrl,
  generateUniqueId,
  sendMail,
  isValidPassword,
  getPlanByNameAndDuration,
  getPlanInfo,
  generateId,
  queueMail,
  dateAfterYear,
  getDaysDifference,
  dateConverter,
  now,
  getClientDetails,
  calculateLicenseStats,
  validateLicenseAvailability,
}

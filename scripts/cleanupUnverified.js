#!/usr/bin/env node
const dbConnect = require('../utils/dbConnect')
const Company = require('../models/Company.model')

// default threshold: 24 hours (in seconds)
// const DEFAULT_THRESHOLD = 24 * 60 * 60
const DEFAULT_THRESHOLD = 30

async function main() {
  try {
    const arg = process.argv[2]
    const threshold = arg ? parseInt(arg, 10) : DEFAULT_THRESHOLD
    if (isNaN(threshold) || threshold <= 0) {
      console.error('Invalid threshold provided. Must be seconds > 0')
      process.exit(1)
    }

    console.log('Connecting to DB...')
    await dbConnect()

    const now = Math.floor(Date.now() / 1000)
    const cutoff = now - threshold

    // Delete companies which are not email verified and either OTP expired or created before cutoff
    const result = await Company.deleteMany({
      isEmailVerified: false,
      $or: [{ otpExpiry: { $lt: now } }, { createdAt: { $lt: cutoff } }],
    })

    console.log(`Cleanup completed. Deleted ${result.deletedCount || 0} unverified accounts (threshold: ${threshold} seconds).`)
    process.exit(0)
  } catch (err) {
    console.error('Cleanup failed:', err.message)
    console.error(err)
    process.exit(2)
  }
}

main()

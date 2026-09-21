const cron = require('node-cron')
const dbConnect = require('../utils/dbConnect')
const Company = require('../models/Company.model')
const EmailLog = require('../models/EmailNotify.model')
const { queueMail, dateConverter, now } = require('../utils/utilities')

const SCHEDULE_AT = '0 5 * * *' // 5:00 AM every day
// const SCHEDULE_AT = '15 17 * * *'

const planExpiryReminder = cron.schedule(
  SCHEDULE_AT,
  async () => {
    try {
      const informBefore = 7
      let oneMonthAgo = new Date()
      oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 1)
      oneMonthAgo = Math.floor(new Date(oneMonthAgo) / 1000)

      await dbConnect()
      const expiringCompanies = await Company.find({ expiredAt: { $lte: now() + informBefore * 24 * 60 * 60 } }, '_id email expiredAt fName').lean()
      let notifiedCompaniesIds = await EmailLog.distinct('userId', { type: 'one_week_before_expiry', createdAt: { $gte: oneMonthAgo } }).lean()
      notifiedCompaniesIds = notifiedCompaniesIds.map((id) => id.toString())
      const companyToNotify = expiringCompanies.filter((user) => !notifiedCompaniesIds.includes(user._id.toString()))

      companyToNotify.forEach(async ({ _id, email, expiredAt, fName }) => {
        await queueMail(email, 'Your plan is expiring', 'planExpiry', { expiredAt: dateConverter(expiredAt, 'LLL'), fName: fName || 'User' })
        await EmailLog.create({ userId: _id, type: 'one_week_before_expiry', createdAt: now() })
      })

      console.log('last fire', new Date().toLocaleTimeString())
      console.log('-------------------------------')
    } catch (error) {
      console.log('Error in my job:', error)
    }
  },
  { scheduled: false }
)

module.exports = planExpiryReminder

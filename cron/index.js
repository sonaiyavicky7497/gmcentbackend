const expiryReminder = require('./expiryReminder')

const startCronJobs = () => {
  expiryReminder.start()
  console.log('All cron jobs started!')
}

module.exports = { startCronJobs }

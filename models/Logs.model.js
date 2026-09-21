const mongoose = require('mongoose')

const userLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, ref: 'User' },
    action: { type: String, required: true },
    message: { type: String },
    createdAt: { type: Number, default: Math.round(Date.now() / 1000) },
  },
  { versionKey: false }
)

const Log = mongoose.model('userLog', userLogSchema)

/**
 * @param {string} userId - The ID of the user triggering the log.
 * @param {string} action - Log action (e.g., 'Project created', 'Login', 'Plan Purchased').
 * @param {string} message - To write some note.
 */

const createLog = async (userId, action, message) => {
  try {
    const logEntry = new Log({ userId, action, message })
    await logEntry.save()
  } catch (error) {
    console.log('Error saving log:', error.message)
  }
}

module.exports = createLog

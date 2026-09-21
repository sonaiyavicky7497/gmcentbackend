const mongoose = require('mongoose')
const { Schema, model } = mongoose

const EmailNotifySchema = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    type: { type: String, enum: ['one_week_before_expiry'], required: true },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const EmailNotify = model('EmailNotify', EmailNotifySchema)
module.exports = EmailNotify

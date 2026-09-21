const mongoose = require('mongoose')
const { Schema, model, Types } = mongoose

const UserFeedbackSchema = new Schema(
  {
    user: { type: Types.ObjectId, required: true, ref: 'Company' },
    type: { type: String, required: true },
    msg: { type: String, required: true },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const UserFeedback = model('UserFeedback', UserFeedbackSchema)
module.exports = UserFeedback

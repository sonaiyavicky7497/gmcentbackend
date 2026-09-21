const mongoose = require('mongoose')
const { Schema, model, Types } = mongoose

const OtpSchema = new Schema(
  {
    email: { type: String, required: true },
    otp: { type: String, required: true },
    otpExpiry: { type: Number, required: true },
    purpose: { type: Number, required: true }, // 1:app user registration
  },
  { versionKey: false, timestamps: false }
)

const Otp = model('Otp', OtpSchema)
module.exports = Otp

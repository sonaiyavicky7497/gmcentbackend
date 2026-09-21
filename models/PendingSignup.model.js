const mongoose = require('mongoose')
const { Schema, model } = mongoose

const pendingSignupSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
    fName: { type: String, required: true },
    lName: { type: String, required: true },
    companyName: { type: String, default: null },
    password: { type: String, required: true },
    otp: { type: String, required: true },
    otpExpiry: { type: Number, required: true },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const PendingSignup = model('PendingSignup', pendingSignupSchema)
module.exports = PendingSignup

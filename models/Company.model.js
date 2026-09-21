const mongoose = require('mongoose')
const { Schema, model } = mongoose

const companySchema = new Schema(
  {
    companyId: { type: String, required: true, unique: true },
    email: { type: String, required: true },
    fName: { type: String, required: true },
    lName: { type: String, required: true },
    companyName: { type: String, default: null },
    website: { type: String, default: null },
    type: { type: String, default: null },
    password: { type: String, default: null },
    isEmailVerified: { type: Boolean, default: false },
    // otp: { type: String, default: null },
    // otpExpiry: { type: String, default: null },
    logo: { type: String, default: null },
    address: { type: String, required: null },
    city: { type: String, required: null },
    country: { type: String, default: null },
    state: { type: String, default: null },
    zipcode: { type: String, default: null },
    phoneCode: { type: String, default: null },
    phone: { type: String, default: null },
    razorpayCustomerId: { type: String, default: null },
    plan: { type: String, default: null },
    currentPaymentId: { type: String, default: null },
    totalSeat: { type: Number, default: 0 },
    usedSeat: { type: Number, default: 0 },
    remainingSeat: { type: Number, default: 0 },
    // seatCapacity: { type: Number, default: 0 },
    // seatPurchased: { type: Number, default: 0 },
    expiredAt: { type: Number, default: null },
    gstin: { type: String, default: null },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const Company = model('Company', companySchema)
module.exports = Company

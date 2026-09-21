const mongoose = require('mongoose')
const { Schema, model } = mongoose

const OwnerUserSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    role: {
      type: Number,
      required: true,
      enum: [1, 2, 3], // 1: Admin, 2: Manager, 3: Viewer
      default: 3,
    },
    status: {
      type: Number,
      default: 0, // DEFAULT IS 0 (Inactive) until OTP verified
      enum: [0, 1],
    },
    otp: {
      type: String,
      default: null,
    },
    otpExpire: {
      type: Number,
      default: null,
    },
    lastLogin: {
      type: Number,
    },
    createdAt: {
      type: Number,
      required: true,
    },
    updatedAt: {
      type: Number,
    },
  },
  {
    versionKey: false,
    timestamps: false,
  },
)

OwnerUserSchema.index({ email: 1 }, { unique: true })
OwnerUserSchema.index({ role: 1 })
OwnerUserSchema.index({ status: 1 })

const Owner = model('Owner', OwnerUserSchema)
module.exports = Owner

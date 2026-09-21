const mongoose = require('mongoose')
const { Schema, model } = mongoose

const UserSchema = new Schema(
  {
    fname: { type: String, required: true },
    lname: {
      type: String,
      required: function () {
        // Require last name ONLY for normal signup (signupType === '1')
        return this.signupType === '1'
      },
      trim: true,
    },
    email: { type: String, required: true },
    password: { type: String, default: null },
    signupType: { type: String, required: true }, // 1: email-password, 2: google, 3: apple
    appleId: { type: String, default: null },
    license: { type: String, default: null }, // License ID from admin invitation
    enterpriseId: { type: String, default: null }, // Company ID (companyId field from Company model)
    companyIds: [{ type: String }], // Track all companies associated with this user
    // currentCompanyId: { type: String, default: null },
    // currentCompanyCode: { type: String, default: null },
    // currentSeatId: { type: String, default: null },
    // currentLicense: { type: String, default: null },
    // currentInvitationId: { type: String, default: null },
    createdAt: { type: Number, default: Math.round(Date.now() / 1000) },
  },
  { versionKey: false, timestamps: false },
)

const User = model('User', UserSchema)
module.exports = User
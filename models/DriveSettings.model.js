const mongoose = require('mongoose')
const { Schema, model } = mongoose

const DriveSettingsSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    googleAccountEmail: { type: String, default: null },
    accessToken: { type: String, default: null },
    refreshToken: { type: String, default: null },
    tokenExpiry: { type: Number, default: null },
    scope: { type: String, default: null },
    isConnected: { type: Boolean, default: false },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const DriveSettings = model('DriveSettings', DriveSettingsSchema)
module.exports = DriveSettings

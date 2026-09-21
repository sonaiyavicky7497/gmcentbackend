// models/SyncLog.model.js
const mongoose = require('mongoose')
const { Schema, model } = mongoose

const SyncLogSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    actionType: { type: String, required: true },
    googleFileId: { type: String, default: null },
    googleFolderId: { type: String, default: null },
    folderId: { type: Schema.Types.ObjectId, ref: 'DriveFolder' },
    seatId: { type: Schema.Types.ObjectId, ref: 'Seat' },
    status: { type: String, enum: ['success', 'error', 'partial'], required: true }, // Added 'partial'
    message: { type: String, default: null },
    syncedAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const SyncLog = model('SyncLog', SyncLogSchema)
module.exports = SyncLog
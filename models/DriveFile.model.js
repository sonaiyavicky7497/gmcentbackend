const mongoose = require('mongoose')
const { Schema, model } = mongoose

const DriveFileSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    seatId: { type: Schema.Types.ObjectId, ref: 'Seat', default: null },
    folderId: { type: Schema.Types.ObjectId, required: true, ref: 'DriveFolder' },
    googleFileId: { type: String, required: true, unique: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, default: null },
    webContentLink: { type: String, default: null },
    thumbnailLink: { type: String, default: null },
    iconLink: { type: String, default: null },
    mimeType: { type: String, default: null },
    fileSize: { type: Number, default: null },
    owners: { type: Array, default: [] },
    parents: { type: Array, default: [] },
    capabilities: { type: Object, default: {} },
    createdTime: { type: String, default: null },
    modifiedTime: { type: String, default: null },
    uploadedAt: { type: Number, required: true },
    isDeleted: { type: Boolean, default: false },
  },
  { versionKey: false, timestamps: false }
)

// Optimise common queries in Drive file tracking
DriveFileSchema.index({ companyId: 1, folderId: 1, uploadedAt: -1 })
DriveFileSchema.index({ companyId: 1, seatId: 1, uploadedAt: -1 })
DriveFileSchema.index({ companyId: 1, uploadedAt: -1 })

const DriveFile = model('DriveFile', DriveFileSchema)
module.exports = DriveFile

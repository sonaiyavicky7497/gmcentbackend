// models/DriveFolder.model.js
const mongoose = require('mongoose')
const { Schema, model } = mongoose

const DriveFolderSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    googleFolderId: { type: String, required: true, unique: true },
    googleParentFolderId: { type: String, default: null },
    parentFolderId: { type: String, default: null },
    folderName: { type: String, required: true },
    folderDescription: { type: String, default: null },
    folderLink: { type: String, default: null },
    webViewLink: { type: String, default: null },
    createdByAdminSeatId: { type: Schema.Types.ObjectId, ref: 'Seat' },
    status: { type: String, enum: ['active', 'archived'], default: 'active' },
    subfolderCount: { type: Number, default: 0 },
    fileCount: { type: Number, default: 0 },
    assignmentCount: { type: Number, default: 0 },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, default: null },
  },
  { versionKey: false, timestamps: false }
)

const DriveFolder = model('DriveFolder', DriveFolderSchema)
module.exports = DriveFolder
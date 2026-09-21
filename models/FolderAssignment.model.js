// models/FolderAssignment.model.js
const mongoose = require('mongoose')
const { Schema, model } = mongoose

const FolderAssignmentSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    employeeId: { type: Schema.Types.ObjectId, required: true, ref: 'Seat' },
    employeeEmail: { type: String, required: true },
    folderId: { type: Schema.Types.ObjectId, required: true, ref: 'DriveFolder' },
    googleFolderId: { type: String, required: true },
    folderName: { type: String, required: true },
    permission: { type: String, enum: ['reader', 'commenter', 'writer'], default: 'reader' },
    permissionId: { type: String },
    assignedBy: { type: Schema.Types.ObjectId, ref: 'Seat' },
    assignedAt: { type: Number, required: true },
    updatedAt: { type: Number },
  },
  { versionKey: false, timestamps: false }
)

FolderAssignmentSchema.index({ companyId: 1, employeeId: 1 })
FolderAssignmentSchema.index({ companyId: 1, folderId: 1 })
FolderAssignmentSchema.index({ googleFolderId: 1, employeeEmail: 1 })

const FolderAssignment = model('FolderAssignment', FolderAssignmentSchema)
module.exports = FolderAssignment
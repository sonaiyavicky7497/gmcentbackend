const mongoose = require('mongoose')
const { Schema, model } = mongoose

const SharedPermissionSchema = new Schema(
  {
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    googleFileId: { type: String, required: true },
    permissionId: { type: String, required: true },
    type: { type: String, enum: ['user', 'group', 'domain', 'anyone'], default: 'user' },
    emailAddress: { type: String, default: null },
    displayName: { type: String, default: null },
    role: {
      type: String,
      enum: ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'],
      required: true,
    },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

SharedPermissionSchema.index({ companyId: 1, googleFileId: 1, permissionId: 1 }, { unique: true })

const SharedPermission = model('SharedPermission', SharedPermissionSchema)
module.exports = SharedPermission

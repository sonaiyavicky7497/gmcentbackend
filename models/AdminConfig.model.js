const mongoose = require('mongoose')
const { Schema, model, Types } = mongoose

const AdminConfigSchema = new Schema(
  {
    owner: { type: Types.ObjectId, required: true, ref: 'Company' },
    metaKey: { type: String, required: true },
    metaValue: { type: String, required: true },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const AdminConfig = model('AdminConfig', AdminConfigSchema)
module.exports = AdminConfig

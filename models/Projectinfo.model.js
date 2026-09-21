const mongoose = require('mongoose')
const { Schema, model, Types } = mongoose

const ProjectInfoSchema = new Schema(
  {
    owner: { type: Types.ObjectId, required: true, ref: 'Company' },
    metaKey: { type: String, required: true, enum: ['logo', 'companyName', 'projectName'] },
    metaValue: { type: String, required: true },
    status: { type: Number, default: 1 },
    createdAt: { type: Number, required: true },
  },
  { versionKey: false, timestamps: false }
)

const ProjectInfo = model('ProjectInfo', ProjectInfoSchema)
module.exports = ProjectInfo

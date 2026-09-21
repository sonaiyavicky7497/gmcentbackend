const mongoose = require('mongoose')
const { Schema, model } = mongoose

const BillingInfoSchema = new Schema(
  {
    owner: { type: Schema.Types.ObjectId, ref: 'Company' },
    line1: { type: String, required: true },
    line2: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, required: true },
    country: { type: String, required: true },
    zipcode: { type: String, required: true },
    gstin: { type: String, default: null },
    isDeleted: { type: Boolean, default: false },
  },
  { versionKey: false, timestamps: false }
)

const BillingInfo = model('BillingInfo', BillingInfoSchema)
module.exports = BillingInfo

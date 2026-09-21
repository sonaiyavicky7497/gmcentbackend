const mongoose = require('mongoose')
const { Schema, model } = mongoose

const CustomPlanSchema = new Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    status: { type: Number, required: true }, // 0: assigned, 1: paid, 2: expired, 3: cancelled, 4: deactivated, 5: refunded
    seat: { type: Number, required: true },
    planExpiry: { type: Number, required: true },
    amount: { type: Number, required: true },
    invoiceExpiry: { type: Number, required: true },
    isActive: { type: Boolean, default: false },
    isRefunded: { type: Boolean, default: false },
    refundStatus: { type: String, default: null },
    refundedAt: { type: Number, default: null },
    activatedAt: { type: Number },
    paymentId: { type: String, default: null },
    orderId: { type: String, default: null },
    invoiceId: { type: String, default: null },
    createdAt: { type: Number, required: true },
    updatedAt: { type: Number },
  },
  { versionKey: false, timestamps: false }
)

const customPlan = model('customPlan', CustomPlanSchema)
module.exports = customPlan

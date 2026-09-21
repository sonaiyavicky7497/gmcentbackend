// models/Transaction.model.js
const mongoose = require('mongoose')

const transactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  invoiceId: {
    type: String,
    required: true,
    index: true,
  },
  paymentId: {
    type: String,
    required: true,
    index: true,
  },
  orderId: {
    type: String,
    index: true,
  },
  plan: {
    type: String,
    required: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  refundAmount: {
    type: Number,
    default: 0,
  },
  netAmount: {
    type: Number,
    default: 0,
  },
  type: {
    type: Number,
    required: true,
    enum: [1, 2, 3, 4, 5, 6],
    // 1: Purchase, 2: Upgrade, 3: Refund Created,
    // 4: Refund Processed, 5: Renewal, 6: Partial Refund
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'refunded', 'partially_refunded', 'failed'],
    default: 'completed',
  },
  refundStatus: {
    type: String,
    enum: ['none', 'requested', 'initiated', 'processed', 'failed'],
    default: 'none',
  },
  refundId: {
    type: String,
  },
  refundNotes: {
    type: String,
  },
  razorpayRefundId: {
    type: String,
  },
  currency: {
    type: String,
    default: 'INR',
  },
  razorpayDetails: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  createdAt: {
    type: Number,
    default: () => Math.floor(Date.now() / 1000),
  },
  updatedAt: {
    type: Number,
    default: () => Math.floor(Date.now() / 1000),
  },
})

// Update timestamps on save
transactionSchema.pre('save', function (next) {
  this.updatedAt = Math.floor(Date.now() / 1000)
  if (!this.netAmount && this.amount) {
    this.netAmount = this.amount - (this.refundAmount || 0)
  }
  next()
})

// Index for faster queries
transactionSchema.index({ paymentId: 1, type: 1 })
transactionSchema.index({ userId: 1, createdAt: -1 })
transactionSchema.index({ refundStatus: 1 })

module.exports = mongoose.models.Transaction || mongoose.model('Transaction', transactionSchema)

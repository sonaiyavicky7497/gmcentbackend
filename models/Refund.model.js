// models/Refund.model.js
const mongoose = require('mongoose')

const refundSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Company',
    required: true,
    index: true,
  },
  paymentId: {
    type: String,
    required: true,
    index: true,
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    index: true,
  },
  refundId: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  razorpayRefundId: {
    type: String,
    required: true,
    index: true,
  },
  amount: {
    type: Number,
    required: true,
  },
  originalAmount: {
    type: Number,
    required: true,
  },
  currency: {
    type: String,
    default: 'INR',
  },
  status: {
    type: String,
    enum: ['initiated', 'processed', 'failed'],
    default: 'initiated',
  },
  refundedBy: {
    type: String,
    enum: ['system', 'dashboard', 'api'],
    default: 'dashboard',
  },
  reason: {
    type: String,
  },
  notes: {
    type: String,
  },
  speedRequested: {
    type: String,
    enum: ['normal', 'instant', 'optimum'],
    default: 'optimum',
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

refundSchema.pre('save', function (next) {
  this.updatedAt = Math.floor(Date.now() / 1000)
  next()
})

module.exports = mongoose.models.Refund || mongoose.model('Refund', refundSchema)

// routes/admin/transact.routes.js
const express = require('express')
const {
  purchasePlan,
  getInvoices,
  getCurrentPlanInfo,
  upgradeSubscription,
  getInvoiceUrl,
  renewPlan,
  extendCurrentPlan,
  getBillingAddress,
  upsertBillingAddress,
  removeBillingAddress,
  getAssignedPlanInfo,
  buyCustomPlan,
  verifyPayment,
  syncRefunds,
  getRefundHistory,
  getTransactionWithRefunds,
  initiateRefund,
  updateTaxDetails,
  deleteTaxDetails,
} = require('../../controller/admin/transact.controller.js')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')

const transactRoute = express.Router()

// Plan purchase and management
transactRoute.post('/purchasePlan', adminTokenValidator, purchasePlan)
transactRoute.post('/verifyPayment', adminTokenValidator, verifyPayment)
transactRoute.post('/verifyPaymentPublic', verifyPayment)
transactRoute.put('/upgradeSubscription', adminTokenValidator, upgradeSubscription)
transactRoute.put('/renewPlan', adminTokenValidator, renewPlan)
transactRoute.put('/extendCurrentPlan', adminTokenValidator, extendCurrentPlan)

// Invoice management
transactRoute.get('/getInvoices', adminTokenValidator, getInvoices)
transactRoute.post('/getInvoiceUrl', adminTokenValidator, getInvoiceUrl)
transactRoute.get('/getCurrentPlanInfo', adminTokenValidator, getCurrentPlanInfo)

// Billing address management
transactRoute.post('/billingAddress', adminTokenValidator, upsertBillingAddress)
transactRoute.get('/billingAddress', adminTokenValidator, getBillingAddress)
transactRoute.delete('/billingAddress', adminTokenValidator, removeBillingAddress)
transactRoute.post('/updateTaxDetails', adminTokenValidator, updateTaxDetails)
transactRoute.delete('/deleteTaxDetails', adminTokenValidator, deleteTaxDetails)

// Custom plans
transactRoute.post('/getmycustomplan', getAssignedPlanInfo)
transactRoute.post('/buyCustomPlan', buyCustomPlan)

// Refund management
transactRoute.post('/syncRefunds', adminTokenValidator, syncRefunds)
transactRoute.get('/getRefundHistory', adminTokenValidator, getRefundHistory)
transactRoute.post('/getTransactionDetails', adminTokenValidator, getTransactionWithRefunds)
transactRoute.post('/initiateRefund', adminTokenValidator, initiateRefund)

// Development-only diagnostic endpoint
if (process.env.NODE_ENV !== 'production') {
  transactRoute.get('/debug/razorpay-config', (req, res) => {
    const key = (process.env.RAZORPAY_KEY || '').trim()
    const secret = (process.env.RAZORPAY_SECRET || '').trim()
    const keyPreview = key.length > 6 ? `${key.slice(0, 4)}...${key.slice(-4)}` : key
    const secretPreview = secret.length > 6 ? `${secret.slice(0, 3)}...${secret.slice(-3)}` : secret
    res.json({
      status: true,
      razorpayKey: { preview: keyPreview, length: key.length },
      razorpaySecret: { preview: secretPreview, length: secret.length },
      message: 'Use this to verify your RAZORPAY_KEY and RAZORPAY_SECRET match your Razorpay account',
    })
  })
}

module.exports = transactRoute

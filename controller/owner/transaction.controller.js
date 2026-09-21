// controller/owner/transaction.controller.js
const Company = require('../../models/Company.model')
const CustomPlan = require('../../models/CustomPlan.model')
const dbConnect = require('../../utils/dbConnect')
const { dec, now, queueMail, dateConverter, enc } = require('../../utils/utilities')

const assignPlan = async (req, res) => {
  try {
    const { companyId } = req.params
    console.log('📝 assignPlan Params:', req.params)
    console.log('📝 assignPlan Body:', req.body)

    const { seat, expiry, amount, invoiceExpiry } = req.body

    if (!seat || !expiry || !companyId || !amount || !invoiceExpiry) {
      console.log('❌ Missing required fields:', { seat, expiry, companyId, amount, invoiceExpiry })
      return res.status(400).json({ msg: 'Invalid request: Missing required fields' })
    }

    await dbConnect()

    let decodedCompanyId
    try {
      // Decode the encrypted company ID
      decodedCompanyId = dec(companyId, process.env.ID_SECRET)
      console.log('🔓 Decoded Company ID:', decodedCompanyId)
    } catch (err) {
      console.error('❌ Decryption failed:', err.message)
      return res.status(400).json({ msg: 'Invalid Company ID format' })
    }

    const companyInfo = await Company.findOne({ _id: decodedCompanyId }).lean()
    if (!companyInfo) {
      console.log('❌ Company not found for ID:', decodedCompanyId)
      return res.status(404).json({ msg: 'Company not found' })
    }

    console.log('✅ Company found:', companyInfo.companyName, companyInfo.email)

    // Find and update existing pending plan or create a new one
    const assignedPlan = await CustomPlan.findOneAndUpdate(
      { userId: decodedCompanyId, status: 0 },
      {
        $set: {
          seat: parseInt(seat),
          amount: parseFloat(amount),
          planExpiry: expiry,
          invoiceExpiry: invoiceExpiry,
          updatedAt: now(),
          isActive: false,
        },
        $unset: { activatedAt: '' },
        $setOnInsert: {
          userId: decodedCompanyId,
          createdAt: now(),
        },
      },
      { upsert: true, new: true },
    )

    console.log('✅ Plan assigned/updated:', assignedPlan._id)

    // Encrypt the plan ID for the purchase URL
    const encPlanId = enc(assignedPlan._id.toString(), process.env.ID_SECRET)
    const frontendUri = process.env.FRONTEND_URI || 'http://localhost:1002'
    const planPurchaseURL = `${frontendUri}/customplanpurchase?u=${encodeURIComponent(companyId)}&p=${encodeURIComponent(encPlanId)}`

    // Send email to customer
    await queueMail(companyInfo.email, 'Purchase link for custom plan', 'customplaninvitation', {
      planPurchaseURL,
      name: companyInfo.fName || 'Valued Customer',
      invoiceExpiry: dateConverter(invoiceExpiry, 'DD/MM/YYYY, hh:mm A'),
    })

    console.log('✅ Email queued for:', companyInfo.email)

    return res.status(201).json({
      status: true,
      msg: 'Plan is assigned to the user',
      data: {
        planPurchaseURL,
        planId: enc(assignedPlan._id.toString(), process.env.ID_SECRET),
      },
    })
  } catch (err) {
    console.log('❌ assignPlan Error:', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const deletePlan = async (req, res) => {
  try {
    const { planId } = req.params
    console.log('🗑️ deletePlan Params:', req.params)

    if (!planId) {
      return res.status(400).json({ msg: 'Invalid request: Plan ID is required' })
    }

    await dbConnect()

    // Decrypt the plan ID
    let decodedPlanId
    try {
      decodedPlanId = dec(planId, process.env.ID_SECRET)
      console.log('🔓 Decoded Plan ID:', decodedPlanId)
    } catch (err) {
      console.error('❌ Plan ID Decryption failed:', err.message)
      return res.status(400).json({ msg: 'Invalid Plan ID format' })
    }

    const planInfo = await CustomPlan.findOne({ _id: decodedPlanId }).lean()

    if (!planInfo) {
      console.log('❌ Plan not found for ID:', decodedPlanId)
      return res.status(404).json({ msg: 'Plan not found' })
    }

    if (planInfo.status === 1) {
      return res.status(400).json({ msg: 'You cannot delete an active/paid plan' })
    }

    await CustomPlan.deleteOne({ _id: decodedPlanId })
    console.log('✅ Plan deleted successfully:', decodedPlanId)

    return res.status(200).json({ status: true, msg: 'Plan deleted successfully' })
  } catch (err) {
    console.log('❌ deletePlan Error:', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

module.exports = { assignPlan, deletePlan }

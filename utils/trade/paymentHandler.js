// utils/trade/paymentHandler.js - Updated with proper seat management
const mongoose = require('mongoose')
const dbConnect = require('../dbConnect')
const Company = require('../../models/Company.model')
const Seat = require('../../models/Seat.model')
const Transaction = require('../../models/Transaction.model')
const Refund = require('../../models/Refund.model')
const CustomPlan = require('../../models/CustomPlan.model')
const BillingInfo = require('../../models/BillingInfo.model')
const { getPlanInfo, getDaysDifference, generateUniqueId, queueMail, now } = require('../utilities')
const Razorpay = require('razorpay')
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY.trim(),
  key_secret: process.env.RAZORPAY_SECRET.trim(),
})
const createLog = require('../../models/Logs.model')

/** Helper: Sync refunds from Razorpay */
const syncRefundsFromRazorpay = async (paymentId, userId) => {
  try {
    if (!paymentId) return []
    await dbConnect()

    console.log(`🔄 Syncing refunds for payment: ${paymentId}`)

    // 1️⃣ Fetch payment & all refunds from Razorpay
    let paymentData
    try {
      paymentData = await razorpay.payments.fetch(paymentId)
    } catch (payErr) {
      console.warn(`⚠️ Could not fetch payment ${paymentId} from Razorpay:`, payErr.message)
    }

    const refundsResponse = await razorpay.refunds.all({ payment_id: paymentId })
    const refunds = refundsResponse.items || []

    // If no refunds in Razorpay and no amount_refunded, nothing to sync
    if (refunds.length === 0 && (!paymentData || paymentData.amount_refunded === 0)) {
      return []
    }

    // 2️⃣ Fetch transaction
    const transaction = await Transaction.findOne({ paymentId })
    const effectiveUserId = userId || transaction?.userId
    const originalAmount = transaction?.amount || (paymentData ? paymentData.amount / 100 : 0)

    let totalRefundAmount = paymentData ? paymentData.amount_refunded / 100 : 0

    // 3️⃣ Upsert refund records in Refund collection
    for (const refundData of refunds) {
      const refundAmount = refundData.amount / 100

      await Refund.findOneAndUpdate(
        { razorpayRefundId: refundData.id },
        {
          $set: {
            userId: effectiveUserId,
            paymentId,
            refundId: refundData.id,
            razorpayRefundId: refundData.id,
            amount: refundAmount,
            originalAmount: originalAmount || refundAmount,
            currency: refundData.currency || 'INR',
            status: refundData.status === 'processed' ? 'processed' : 'initiated',
            refundedBy: 'dashboard',
            reason: refundData.notes?.reason || refundData.notes?.comment || 'Manual refund from Razorpay dashboard',
            notes: JSON.stringify(refundData.notes || {}),
            speedRequested: refundData.speed_processed || 'normal',
            razorpayDetails: refundData,
            createdAt: refundData.created_at || now(),
            updatedAt: now(),
          },
        },
        { upsert: true, new: true },
      )
    }

    // Calculate total refunded amount
    if (totalRefundAmount === 0 && refunds.length > 0) {
      totalRefundAmount = refunds.reduce((sum, r) => sum + (r.amount / 100), 0)
    }

    // 4️⃣ Update Transaction without changing its original type (so getInvoices still displays it)
    if (totalRefundAmount > 0) {
      const netAmount = Math.max(0, originalAmount - totalRefundAmount)
      const isFull = Math.abs(netAmount) < 0.01 || totalRefundAmount >= originalAmount * 0.99
      const newStatus = isFull ? 'refunded' : 'partially_refunded'

      await Transaction.updateOne(
        { paymentId },
        {
          $set: {
            refundAmount: totalRefundAmount,
            netAmount: netAmount,
            refundStatus: 'processed',
            status: newStatus,
            razorpayRefundId: refunds[0]?.id || '',
            updatedAt: now(),
          },
        },
      )
      console.log(`✅ Updated transaction ${paymentId}: original=₹${originalAmount}, refunded=₹${totalRefundAmount}, net=₹${netAmount}, status=${newStatus}`)
    }

    // 5️⃣ Check if this payment was for the company's plan or a custom plan!
    if (effectiveUserId && totalRefundAmount > 0) {
      const company = await Company.findOne({ _id: effectiveUserId })
      if (company && company.currentPaymentId === paymentId) {
        console.log(`🚨 ACTIVE PLAN PAYMENT ${paymentId} HAS BEEN REFUNDED (₹${totalRefundAmount})! Deactivating company plan...`)

        // Deactivate company plan
        await Company.updateOne(
          { _id: effectiveUserId },
          {
            $set: {
              plan: null,
              expiredAt: null,
              totalSeat: 0,
              usedSeat: 0,
              remainingSeat: 0,
              seatCapacity: 0,
              seatPurchased: 0,
              currentPaymentId: null,
              updatedAt: now(),
            },
          },
        )

        // Revoke active & pending seats
        await Seat.updateMany(
          { companyId: effectiveUserId, status: { $in: ['0', '1'] } },
          {
            $set: {
              status: '3',
              lastActive: now(),
              updatedAt: now(),
            },
          },
        )

        createLog(effectiveUserId, 'Plan Revoked due to Razorpay Refund', `Payment ${paymentId} refunded ₹${totalRefundAmount}`)
        console.log(`🔒 Company ${effectiveUserId} plan successfully revoked and seats deactivated due to refund.`)
      }

      // Deactivate and mark custom plan as refunded (status: 5)
      // ONLY IF this refunded payment was specifically for the custom plan AND it is a full refund!
      const isFullRefund = totalRefundAmount >= originalAmount * 0.99
      const isCustomPlanPayment =
        transaction?.plan === 'Enterprise' ||
        (company && company.plan === 'Enterprise' && company.currentPaymentId === paymentId)

      if (isCustomPlanPayment && isFullRefund) {
        // Find the specific custom plan associated with THIS payment
        const targetCustomPlan = await CustomPlan.findOne({
          userId: effectiveUserId,
          $or: [
            { paymentId: paymentId },
            ...(transaction?.invoiceId ? [{ invoiceId: transaction.invoiceId }] : []),
            ...(transaction?.orderId ? [{ orderId: transaction.orderId }] : []),
            ...(transaction?.createdAt
              ? [
                  {
                    amount: transaction.amount,
                    activatedAt: {
                      $gte: transaction.createdAt - 120,
                      $lte: transaction.createdAt + 120,
                    },
                  },
                ]
              : []),
          ],
        }).sort({ activatedAt: -1 })

        if (targetCustomPlan) {
          await CustomPlan.updateOne(
            { _id: targetCustomPlan._id },
            {
              $set: {
                status: 5, // Refunded / Deactivated
                isActive: false,
                isRefunded: true,
                refundStatus: 'refunded',
                refundedAt: now(),
                updatedAt: now(),
              },
            },
          )
          console.log(`🔒 Custom plan ${targetCustomPlan._id} marked as refunded and deactivated (status: 5) for payment ${paymentId}`)
        }
      }
    }

    return refunds
  } catch (error) {
    console.error('❌ Error syncing refunds from Razorpay:', error.message)
    return []
  }
}

/** Helper: Start and manage a transaction with retries for WriteConflict */
const withTransaction = async (fn) => {
  const maxRetries = 3
  let currentRetry = 0

  while (currentRetry < maxRetries) {
    const session = await mongoose.startSession()
    session.startTransaction()
    try {
      const result = await fn(session)
      await session.commitTransaction()
      return result
    } catch (error) {
      await session.abortTransaction()

      // Retry if it's a WriteConflict (code 112) or transient error
      const isTransient = error.hasErrorLabel && error.hasErrorLabel('TransientTransactionError')
      const isWriteConflict = error.code === 112

      if ((isTransient || isWriteConflict) && currentRetry < maxRetries - 1) {
        currentRetry++
        const delay = Math.pow(2, currentRetry) * 100 // 200ms, 400ms...
        console.warn(`⚠️ Transaction conflict, retrying (${currentRetry}/${maxRetries}) in ${delay}ms...`)
        await new Promise((res) => setTimeout(res, delay))
        continue
      }

      console.error('❌ Transaction failed:', error.message)
      throw error
    } finally {
      session.endSession()
    }
  }
}

/** Helper: Record a transaction */
const recordTransaction = async (userId, details, session) => {
  const transaction = new Transaction({
    ...details,
    userId,
    createdAt: now(),
    updatedAt: now(),
  })
  await transaction.save({ session })
  console.log('📝 Transaction recorded:', details.invoiceId)
  return transaction
}

/** Helper: Record a refund transaction */
const recordRefundTransaction = async (userId, details, session) => {
  const refundTransaction = new Transaction({
    userId: userId,
    invoiceId: details.invoiceId || `refund_${Date.now()}`,
    paymentId: details.paymentId,
    orderId: details.orderId,
    plan: details.plan,
    amount: details.amount,
    refundAmount: details.refundAmount || details.amount,
    netAmount: 0 - (details.refundAmount || details.amount),
    type: details.type || 4,
    status: 'refunded',
    refundStatus: 'processed',
    refundId: details.refundId,
    razorpayRefundId: details.razorpayRefundId,
    currency: details.currency || 'INR',
    refundNotes: details.refundNotes,
    createdAt: details.createdAt || now(),
    updatedAt: now(),
  })

  await refundTransaction.save({ session })
  console.log('📝 Refund transaction recorded:', details.refundId)
  return refundTransaction
}

/** Helper: Refund old plan amount */
const refundOldPlan = async (company, notes, userId) => {
  try {
    console.log('🔄 Starting refund process for old plan...')
    console.log(`📊 Company plan: ${company.plan}, expiredAt: ${company.expiredAt}, currentPaymentId: ${company.currentPaymentId}`)

    // Validate prerequisites
    if (!company.currentPaymentId) {
      console.log('⚠️ No current payment ID found - skipping refund')
      return { success: false, amount: 0, reason: 'No payment ID' }
    }

    if (!company.expiredAt) {
      console.log('⚠️ No expiry date found - skipping refund')
      return { success: false, amount: 0, reason: 'No expiry date' }
    }

    const currentUnixTimestamp = now()
    const remainingSeconds = Math.max(0, Number(company.expiredAt) - currentUnixTimestamp)
    const remainingDays = Math.ceil(remainingSeconds / 86400)
    console.log(`📅 Remaining seconds: ${remainingSeconds}, Days left in current plan: ${remainingDays}`)

    if (remainingSeconds <= 0 || remainingDays <= 0) {
      console.log('⚠️ Plan already expired - no refund needed')
      return { success: false, amount: 0, reason: 'Plan expired' }
    }

    // Fetch the original payment
    let userOldPlanPayment
    try {
      userOldPlanPayment = await razorpay.payments.fetch(company.currentPaymentId)
      console.log(
        `💳 Old payment fetched: ${userOldPlanPayment.id}, status: ${userOldPlanPayment.status}, amount: ${userOldPlanPayment.amount / 100}`,
      )
    } catch (fetchErr) {
      console.error('❌ Failed to fetch old payment:', fetchErr.message)
      return { success: false, amount: 0, reason: `Failed to fetch payment: ${fetchErr.message}` }
    }

    // Check if payment is eligible for refund
    if (userOldPlanPayment.status !== 'captured') {
      console.log(`⚠️ Payment status is ${userOldPlanPayment.status} - cannot refund`)
      return { success: false, amount: 0, reason: `Payment not captured (status: ${userOldPlanPayment.status})` }
    }

    // Check for existing refunds on this payment from DB and Razorpay
    let totalRefunded = 0
    try {
      const dbRefunds = await Refund.find({ paymentId: company.currentPaymentId })
      const dbRefundedTotal = dbRefunds.reduce((sum, r) => sum + (r.amount || 0), 0)

      let rzpRefundedTotal = 0
      try {
        const rzpRefunds = await razorpay.refunds.all({ payment_id: company.currentPaymentId })
        rzpRefundedTotal = (rzpRefunds.items || []).reduce((sum, r) => sum + (r.amount / 100), 0)
      } catch (rzpErr) {
        console.warn('⚠️ Could not check refunds from Razorpay API:', rzpErr.message)
      }

      totalRefunded = Math.max(dbRefundedTotal, rzpRefundedTotal)
      const userPaidAmount = userOldPlanPayment.amount / 100
      const remainingRefundable = Math.max(0, Number((userPaidAmount - totalRefunded).toFixed(2)))

      console.log(`💰 Already refunded: ₹${totalRefunded}, Remaining refundable: ₹${remainingRefundable}`)

      if (remainingRefundable <= 0) {
        console.log('⚠️ Payment already fully refunded')
        return { success: false, amount: 0, reason: 'Already fully refunded' }
      }
    } catch (refundCheckErr) {
      console.warn('⚠️ Could not check existing refunds:', refundCheckErr.message)
    }

    // Calculate total plan duration (default 365, or from custom plan if Enterprise)
    let totalPlanDays = 365
    if (company.plan === 'Enterprise') {
      try {
        const activeCustomPlan = await CustomPlan.findOne({
          userId: new mongoose.Types.ObjectId(userId),
          status: 1,
        }).sort({ createdAt: -1 })
        if (activeCustomPlan && activeCustomPlan.planExpiry && activeCustomPlan.createdAt) {
          totalPlanDays = Math.max(1, Math.round((activeCustomPlan.planExpiry - activeCustomPlan.createdAt) / 86400))
        }
      } catch (cpErr) {
        console.warn('⚠️ Could not determine custom plan total days, defaulting to 365:', cpErr.message)
      }
    }

    // Calculate refund amount
    const userPaidAmount = userOldPlanPayment.amount / 100
    const remainingRefundable = Math.max(0, Number((userPaidAmount - totalRefunded).toFixed(2)))
    const userPerDayCost = userPaidAmount / totalPlanDays
    const eligibleAmount = Number((userPerDayCost * Math.min(totalPlanDays, remainingDays)).toFixed(2))
    const finalRefundAmount = Math.min(userPaidAmount, remainingRefundable, eligibleAmount)
    const refundableAmount = Math.round(finalRefundAmount * 100) // in paise

    console.log(
      `💵 Calculated refund: ₹${finalRefundAmount} (${remainingDays}/${totalPlanDays} days × ₹${userPerDayCost.toFixed(2)}/day, max refundable: ₹${remainingRefundable})`,
    )

    if (refundableAmount <= 0) {
      console.log('⚠️ Refund amount too small')
      return { success: false, amount: 0, reason: 'Refund amount too small' }
    }

    // Check minimum refund amount (Razorpay minimum is 100 paise = ₹1)
    if (refundableAmount < 100) {
      console.log('⚠️ Refund amount below minimum (₹1)')
      return { success: false, amount: 0, reason: 'Below minimum refund amount' }
    }

    // Process the refund via Razorpay API
    try {
      const refund = await razorpay.payments.refund(company.currentPaymentId, {
        amount: refundableAmount,
        speed: 'optimum',
        notes: {
          from: company.plan,
          to: notes.planName,
          userId: userId.toString(),
          reason: `Upgrade from ${company.plan} to ${notes.planName}`,
          daysLeft: remainingDays,
          originalAmount: userPaidAmount,
        },
      })

      const refundAmountInRupees = Number((refundableAmount / 100).toFixed(2))
      console.log(`✅ Refund successful: ${refund.id}, Amount: ₹${refundAmountInRupees}`)

      // 1️⃣ Save Refund in MongoDB
      const oldTransaction = await Transaction.findOne({ paymentId: company.currentPaymentId })
      const refundDoc = new Refund({
        userId: new mongoose.Types.ObjectId(userId),
        paymentId: company.currentPaymentId,
        transactionId: oldTransaction ? oldTransaction._id : undefined,
        refundId: refund.id,
        razorpayRefundId: refund.id,
        amount: refundAmountInRupees,
        originalAmount: userPaidAmount,
        currency: refund.currency || 'INR',
        status: refund.status === 'processed' ? 'processed' : 'initiated',
        refundedBy: 'system',
        reason: `Upgrade from ${company.plan} to ${notes.planName}`,
        notes: JSON.stringify(refund.notes || {}),
        speedRequested: refund.speed_requested || 'optimum',
        razorpayDetails: refund,
        createdAt: refund.created_at || now(),
        updatedAt: now(),
      })
      await refundDoc.save()
      console.log(`💾 Refund document saved in MongoDB: ${refundDoc._id}`)

      // 2️⃣ Update Old Transaction
      if (oldTransaction) {
        const totalNewRefundAmount = Number(((oldTransaction.refundAmount || 0) + refundAmountInRupees).toFixed(2))
        const newNetAmount = Math.max(0, Number((oldTransaction.amount - totalNewRefundAmount).toFixed(2)))
        const newStatus = newNetAmount <= 0.01 ? 'refunded' : 'partially_refunded'

        await Transaction.updateOne(
          { _id: oldTransaction._id },
          {
            $set: {
              refundAmount: totalNewRefundAmount,
              netAmount: newNetAmount,
              refundStatus: 'processed',
              refundId: refund.id,
              razorpayRefundId: refund.id,
              status: newStatus,
              updatedAt: now(),
            },
          },
        )
        console.log(`💾 Old transaction updated: refundAmount=₹${totalNewRefundAmount}, netAmount=₹${newNetAmount}`)
      }

      return {
        success: true,
        amount: refundAmountInRupees,
        refundId: refund.id,
        daysLeft: remainingDays,
        originalPlan: company.plan,
      }
    } catch (refundErr) {
      console.error('❌ Razorpay refund API error:', refundErr.message)

      if (refundErr.error) {
        console.error('Razorpay error details:', JSON.stringify(refundErr.error, null, 2))
      }

      return {
        success: false,
        amount: 0,
        reason: refundErr.error?.description || refundErr.message,
      }
    }
  } catch (err) {
    console.error('❌ Unexpected error in refundOldPlan:', err.message)
    console.error(err.stack)
    return { success: false, amount: 0, reason: err.message }
  }
}

/** Helper: Update company plan - FIXED SEAT CALCULATION */
const updateCompanyPlan = async (userId, totalSeats, paymentId, session, notes) => {
  console.log(`🔄 Updating company plan for user ${userId}`)
  console.log(`📊 Plan details: ${notes.planName}, Total seats: ${totalSeats}`)

  // Get current company info to understand current state
  const company = await Company.findById(userId).session(session)
  if (!company) throw new Error('Company not found')

  console.log(`📊 Current company state: Plan: ${company.plan}, TotalSeat: ${company.totalSeat}, UsedSeat: ${company.usedSeat}, RemainingSeat: ${company.remainingSeat}`)

  let totalSeat = totalSeats
  let usedSeat = company.usedSeat !== undefined ? company.usedSeat : (company.seatPurchased || 0)

  // Handle different scenarios
  if (!company.plan && !notes.isRenewing && !notes.isUpgrading) {
    // FIRST-TIME PURCHASE
    console.log('🆕 First-time purchase scenario')
    usedSeat = 0
    totalSeat = totalSeats
  } else if ((notes.isCustomPlan === true || notes.isCustomPlan === 'true' || notes.planName === 'Enterprise') && notes.seat) {
    // CUSTOM PLAN PURCHASE
    console.log('🎯 Custom plan purchase scenario')
    totalSeat = parseInt(notes.seat)
  } else if ((notes.isUpgrading === true || notes.isUpgrading === 'true') && notes.planName) {
    // UPGRADE SCENARIO
    console.log('⬆️ Upgrade scenario')
    totalSeat = totalSeats
  } else if (notes.isRenewing === true || notes.isRenewing === 'true') {
    // RENEWAL SCENARIO
    console.log('🔄 Renewal scenario')
    totalSeat = totalSeats
  } else {
    // DEFAULT SCENARIO
    console.log('⚠️ Default scenario')
    totalSeat = totalSeats
  }

  let remainingSeat = totalSeat - usedSeat
  // Ensure remaining is not negative
  if (remainingSeat < 0) remainingSeat = 0

  const updateData = {
    currentPaymentId: paymentId,
    expiredAt: notes.endAt,
    plan: notes.planName,
    totalSeat: totalSeat,
    usedSeat: usedSeat,
    remainingSeat: remainingSeat,
    seatPurchased: usedSeat,
    seatCapacity: remainingSeat,
    updatedAt: now(),
  }

  console.log(`📊 Final update data:`, updateData)
  console.log(`✅ Total: ${totalSeat}, Used: ${usedSeat}, Remaining: ${remainingSeat}`)

  await Company.updateOne({ _id: userId }, updateData, { session })
  createLog(userId, 'Plan Updated', `${notes.planName} - Seats: ${totalSeats}`)

  console.log('✅ Company plan updated successfully')
}

/** Helper: Update company on refund */
const updateCompanyOnRefund = async (userId, refundAmount, isFullRefund, session) => {
  const company = await Company.findById(userId).session(session)

  if (!company) {
    throw new Error('Company not found for refund update')
  }

  if (isFullRefund) {
    // Full refund - cancel the plan
    await Company.updateOne(
      { _id: userId },
      {
        $set: {
          plan: null,
          expiredAt: null,
          seatCapacity: 0,
          seatPurchased: 0,
          currentPaymentId: null,
          updatedAt: now(),
        },
      },
      { session },
    )

    // Revoke all seats
    await Seat.updateMany(
      { companyId: userId, status: { $ne: '3' } },
      {
        $set: { status: 3, updatedAt: now() },
      },
      { session },
    )

    // Deactivate and mark custom plan as refunded only if company had an Enterprise plan
    if (company.plan === 'Enterprise') {
      await CustomPlan.updateMany(
        { userId, isActive: true },
        {
          $set: {
            status: 5,
            isActive: false,
            isRefunded: true,
            refundStatus: 'refunded',
            refundedAt: now(),
            updatedAt: now(),
          },
        },
        { session },
      )
    }

    console.log(`✅ Full refund: Plan cancelled, custom plan refunded, and seats revoked for user ${userId}`)
  } else {
    // Partial refund - update company stats if needed
    console.log(`ℹ️ Partial refund: No plan changes for user ${userId}`)
  }

  return company
}

/** Helper: Create a new license and send an invitation email */
const createLicenseAndNotify = async (userId, notes, session) => {
  const normalizedEmail = notes?.email ? notes.email.trim().toLowerCase() : null
  if (!normalizedEmail) throw new Error('Admin email is required to create license')

  // Idempotency guard: do not create duplicate active/pending admin seat for same company/email.
  const existingSeat = await Seat.findOne({
    companyId: userId,
    email: normalizedEmail,
    status: { $in: ['0', '1'] },
  })
    .session(session)
    .lean()

  if (existingSeat) {
    console.log(`ℹ️ Admin seat already exists for ${normalizedEmail} (${existingSeat.license}), skipping create`)
    return existingSeat.license
  }

  const licenseId = generateUniqueId()

  await Seat.create(
    [
      {
        companyId: userId,
        fname: notes.fname,
        lname: notes.lname,
        email: normalizedEmail,
        license: licenseId,
        role: 'Admin',
        status: 0,
        createdAt: now(),
      },
    ],
    { session },
  )
  const company = await Company.findOne({ _id: userId }).lean()

  await queueMail(normalizedEmail, 'Welcome to GPS Map Camera ENT!', 'invitation', {
    email: normalizedEmail,
    licenseId,
    companyId: company?.companyId,
    companyName: company?.companyName,
    name: notes.fname,
  })

  createLog(userId, 'New License', `${notes.fname} ${notes.lname}: ${notes.email}`)

  console.log('👤 Admin license created and invitation sent')
  return licenseId
}

/** Helper: Create invoice for payment - PREVENT DUPLICATE INVOICES */
// const createInvoiceForPayment = async (paymentId, notes, planInfo) => {
//   try {
//     console.log(`🔍 Creating invoice for payment: ${paymentId}`)

//     // Fetch payment details first
//     let payment
//     try {
//       payment = await razorpay.payments.fetch(paymentId)
//       console.log(`✅ Payment fetched: ${paymentId}, Amount: ${payment.amount / 100}`)
//     } catch (paymentErr) {
//       console.error('❌ Error fetching payment:', paymentErr.message)
//       return paymentId // Return payment ID as fallback
//     }

//     const company = await Company.findOne({ _id: notes.userId }).lean()

//     if (!company || !company.razorpayCustomerId) {
//       console.warn('⚠️ Cannot create invoice: No customer ID')
//       return paymentId // Return payment ID as fallback
//     }

//     // Check if invoice already exists for this payment
//     const invoiceList = await razorpay.invoices.all({
//       payment_id: paymentId,
//       count: 1,
//     })

//     if (invoiceList.items && invoiceList.items.length > 0) {
//       console.log('✅ Invoice already exists:', invoiceList.items[0].id)
//       return invoiceList.items[0].id
//     }

//     // Check if invoice already exists by checking transaction in our DB
//     const existingTransaction = await Transaction.findOne({
//       paymentId: paymentId,
//       userId: notes.userId,
//     })

//     if (existingTransaction && existingTransaction.invoiceId && existingTransaction.invoiceId !== paymentId) {
//       console.log('✅ Invoice already created in our system:', existingTransaction.invoiceId)
//       return existingTransaction.invoiceId
//     }

//     // Create new invoice
//     const invoice = await razorpay.invoices.create({
//       type: 'invoice',
//       description: `Invoice for ${notes.planName} plan`,
//       customer_id: company.razorpayCustomerId,
//       line_items: [
//         {
//           name: `${notes.planName} Plan - ${planInfo.seat} Users`,
//           description: `Enterprise plan with ${planInfo.seat} user licenses`,
//           amount: payment.amount,
//           currency: payment.currency,
//           quantity: 1,
//         },
//       ],
//       email_notify: 1,
//       sms_notify: 1,
//       partial_payment: false,
//       notes: {
//         payment_id: paymentId,
//         order_id: payment.order_id || '',
//         ...notes,
//       },
//     })

//     console.log('✅ Invoice created:', invoice.id)
//     return invoice.id
//   } catch (err) {
//     console.error('❌ Error creating invoice:', err.message)
//     return paymentId // Return payment ID as fallback
//   }
// }

/** Helper: Create refund in Razorpay */
const createRazorpayRefund = async (paymentId, amount, notes = {}) => {
  try {
    const refundData = {
      amount: Math.round(amount * 100), // Convert to paise
      speed: 'optimum',
      notes: {
        refund_reason: notes.reason || 'Customer request',
        refund_initiated_by: notes.initiatedBy || 'system',
        ...notes,
      },
    }

    const refund = await razorpay.payments.refund(paymentId, refundData)
    console.log(`✅ Razorpay refund created: ${refund.id}, Amount: ${refund.amount / 100}`)
    return refund
  } catch (error) {
    console.error('❌ Error creating Razorpay refund:', error.message)
    throw error
  }
}

/** Helper: Calculate seat information */
const calculateSeatInfo = async (userId, notes, totalSeats) => {
  const company = await Company.findById(userId)

  if (!company) {
    return {
      totalSeat: totalSeats,
      usedSeat: 0,
      remainingSeat: totalSeats,
      seatPurchased: 0,
      seatCapacity: totalSeats,
      usedSeats: 0,
      availableSeats: totalSeats,
    }
  }

  let seatPurchased = company.seatPurchased || 0
  let seatCapacity = 0

  if (!company.plan && !(notes.isRenewing === true || notes.isRenewing === 'true') && !(notes.isUpgrading === true || notes.isUpgrading === 'true')) {
    // First purchase — admin seat auto-creation disabled; user gets all seats
    seatPurchased = 0
    seatCapacity = totalSeats
  } else if ((notes.isCustomPlan === true || notes.isCustomPlan === 'true' || notes.planName === 'Enterprise') && notes.seat) {
    // Custom plan
    seatPurchased = company.seatPurchased || 0
    seatCapacity = parseInt(notes.seat) - seatPurchased
  } else if (notes.isUpgrading === true || notes.isUpgrading === 'true') {
    // Upgrade
    const currentPlanInfo = getPlanInfo(company.plan)
    const currentTotalSeats = currentPlanInfo ? currentPlanInfo.seat : 0
    const additionalSeats = totalSeats - currentTotalSeats
    seatPurchased = company.seatPurchased || 0
    seatCapacity = (company.seatCapacity || 0) + additionalSeats
  } else if (notes.isRenewing === true || notes.isRenewing === 'true') {
    // Renewal
    seatPurchased = company.seatPurchased || 0
    seatCapacity = totalSeats - seatPurchased
  } else {
    // Default
    seatPurchased = company.seatPurchased || 0
    seatCapacity = totalSeats - seatPurchased
  }

  if (seatCapacity < 0) seatCapacity = 0

  const totalSeat = (notes.isCustomPlan === true || notes.isCustomPlan === 'true' || notes.planName === 'Enterprise') && notes.seat
    ? parseInt(notes.seat)
    : totalSeats
  const usedSeat = seatPurchased
  const remainingSeat = seatCapacity

  return {
    totalSeat,
    usedSeat,
    remainingSeat,
    seatPurchased,
    seatCapacity,
    usedSeats: seatPurchased,
    availableSeats: seatCapacity,
  }
}

/** Main handler: Process payment based on type - FIXED SEAT MANAGEMENT */
const handleOrderPaid = async (payload) => {
  try {
    const { payment } = payload
    if (!payment || !payment.entity) {
      throw new Error('Invalid payload: payment entity missing')
    }

    const { id: paymentId, amount, currency, invoice_id, order_id } = payment.entity

    // Notes can be in payment.entity.notes OR payload.order.entity.notes OR payload.invoice.entity.notes
    let notes = payment.entity.notes || {}

    if (Object.keys(notes).length === 0 && payload.order?.entity?.notes) {
      notes = payload.order.entity.notes
      console.log('📝 Found notes in payload.order.entity')
    } else if (Object.keys(notes).length === 0 && payload.invoice?.entity?.notes) {
      notes = payload.invoice.entity.notes
      console.log('📝 Found notes in payload.invoice.entity')
    }

    console.log('='.repeat(50))
    console.log('💰 HANDLE ORDER PAID')
    console.log('Payment ID:', paymentId)
    console.log('Order ID:', order_id)
    console.log('Invoice ID:', invoice_id)
    console.log('Notes:', JSON.stringify(notes, null, 2))
    console.log('='.repeat(50))

    if (!notes || !notes.userId) {
      console.warn('⚠️ userId not found in notes. Skipping.')
      return
    }

    const userId = notes.userId

    await dbConnect()

    // Check for duplicate
    const existingTransaction = await Transaction.findOne({
      paymentId: paymentId,
      userId: userId,
    })

    if (existingTransaction) {
      console.log(`⚠️ Payment ${paymentId} already processed, skipping...`)
      return
    }

    // Sync any existing refunds first
    await syncRefundsFromRazorpay(paymentId, userId)

    // Get plan info and determine seat count
    let totalSeats = notes?.seat ? parseInt(notes.seat) : 2 // Default to notes.seat or 2
    const planInfo = getPlanInfo(notes.planName)

    // Only override with planInfo.seat IF it actually exists (standard plans)
    if (planInfo && planInfo.seat) {
      totalSeats = planInfo.seat
    }

    console.log(`🪑 Total seats for plan ${notes.planName}: ${totalSeats}`)

    // Determine transaction type
    let transactionType = 1 // Default: new purchase
    const isUpgrading = notes.isUpgrading === true || notes.isUpgrading === 'true'
    const isRenewing = notes.isRenewing === true || notes.isRenewing === 'true'
    const isCustomPlan =
      notes.isCustomPlan === true || notes.isCustomPlan === 'true' || (notes.planName === 'Enterprise' && (notes.customPlanId || notes.planId))
    const customPlanId = notes.customPlanId || notes.planId

    if (isUpgrading) {
      transactionType = 2
    } else if (isRenewing) {
      transactionType = 5
    }

    // Try to get or create invoice ID - PREVENT DUPLICATE INVOICES
    let invoiceId = invoice_id || null

    // Check if we already have an invoice for this payment
    // if (planInfo) {
    //   try {
    //     const createdInvoiceId = await createInvoiceForPayment(paymentId, notes, planInfo)
    //     if (createdInvoiceId) {
    //       invoiceId = createdInvoiceId
    //     }
    //   } catch (invoiceErr) {
    //     console.warn('⚠️ Could not create invoice:', invoiceErr.message)
    //   }
    // }

    console.log(`📋 Processing ${isUpgrading ? 'UPGRADE' : isRenewing ? 'RENEWAL' : 'PURCHASE'} for user ${userId}`)

    await withTransaction(async (session) => {
      // Get current company state - PRIORITIZE userId from notes to avoid shadow companies
      console.log(`🔍 Webhook: Finding company: ID=${userId}, Email=${notes.email}`)
      let company = await Company.findById(userId).session(session)

      if (!company && notes.email) {
        console.log('🔍 Lookup by ID failed, trying email...')
        company = await Company.findOne({ email: notes.email }).session(session)
      }

      if (!company) {
        console.log(`🆕 Company not found by ID or email. Creating new...`)
        // Create new company for this user
        const companyId = `comp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
        const newCompany = new Company({
          companyId,
          email: notes.email || `user_${Date.now()}@temp.com`,
          fName: notes.fname || 'New',
          lName: notes.lname || 'User',
          companyName: notes.companyName || (notes.fname ? `${notes.fname} ${notes.lname || ''}` : 'New Company'),
          isEmailVerified: true,
          createdAt: now(),
        })

        await newCompany.save({ session })
        company = newCompany
      }

      console.log(`📊 Processing payment for: ${company.companyName} (${company._id})`)

      // Record transaction
      await recordTransaction(
        company._id.toString(),
        {
          invoiceId,
          paymentId,
          plan: notes.planName,
          amount: amount / 100,
          type: transactionType,
          currency,
        },
        session,
      )

      // ==========================================
      // HANDLE PLAN UPDATE (Upgrade, Renewal, or Purchase)
      // ==========================================
      if (isUpgrading && company.plan && company.currentPaymentId) {
        console.log('⬆️ Webhook: Processing upgrade with refund...')
        const usedSeats = company.seatPurchased || 0
        const seatCapacity = totalSeats - usedSeats
        if (seatCapacity < 0) throw new Error(`Used seats (${usedSeats}) exceed new plan seats (${totalSeats})`)

        const companyForRefund = { ...company.toObject() }
        await updateCompanyPlan(company._id.toString(), totalSeats, paymentId, session, notes)

        setImmediate(async () => {
          try {
            await refundOldPlan(companyForRefund, notes, company._id.toString())
          } catch (refundErr) {
            console.error('❌ Webhook refund error:', refundErr.message)
          }
        })
      } else if (isRenewing) {
        console.log('🔄 Webhook: Processing renewal...')
        const usedSeats = company.usedSeat !== undefined ? company.usedSeat : (company.seatPurchased || 0)
        const seatCapacity = Math.max(0, totalSeats - usedSeats)
        if (totalSeats < usedSeats) throw new Error(`Used seats (${usedSeats}) exceed plan seats (${totalSeats})`)

        await Company.updateOne(
          { _id: company._id },
          {
            currentPaymentId: paymentId,
            plan: notes.planName,
            totalSeat: totalSeats,
            usedSeat: usedSeats,
            remainingSeat: seatCapacity,
            seatPurchased: usedSeats,
            seatCapacity: seatCapacity,
            expiredAt: notes.endAt,
            updatedAt: now(),
          },
          { session },
        )
      } else {
        // New purchase
        console.log('🆕 Webhook: Processing new purchase...')
        if (isCustomPlan && notes.seat) totalSeats = parseInt(notes.seat)

        let seatPurchased = company.seatPurchased || 0
        let seatCapacity = 0

        if (!company.plan) {
          // First purchase — admin seat auto-creation disabled; user gets all seats
          // seatPurchased = 1
          // seatCapacity = totalSeats - 1
          // await createLicenseAndNotify(company._id.toString(), notes, session)
          seatPurchased = 0
          seatCapacity = totalSeats
        } else {
          seatPurchased = company.seatPurchased || 0
          seatCapacity = totalSeats - seatPurchased
          if (seatCapacity < 0) throw new Error(`Current seats (${seatPurchased}) exceed plan seats (${totalSeats})`)
        }

        await updateCompanyPlan(company._id.toString(), totalSeats, paymentId, session, notes)
      }

      // ==========================================
      // ✅ PROPER CUSTOM PLAN ACTIVATION
      // ==========================================
      const effectiveCustomPlanId = customPlanId || notes?.customPlanId || notes?.planId
      if (isCustomPlan === true || isCustomPlan === 'true' || notes?.planName === 'Enterprise' || effectiveCustomPlanId) {
        console.log('🔄 Webhook: Updating custom plan status...')
        try {
          const mongoose = require('mongoose')
          const ObjectId = mongoose.Types.ObjectId

          // Ensure IDs are ObjectIds for accurate matching
          const targetPlanId = effectiveCustomPlanId && ObjectId.isValid(effectiveCustomPlanId) ? new ObjectId(effectiveCustomPlanId) : null
          const targetUserId = company._id

          const actualPaymentId = paymentId || null
          const actualOrderId = order_id || null
          const actualInvoiceId = invoiceId || invoice_id || null

          let activatedPlanId = null

          // 1. Activate the paid plan (Try by ID first)
          if (targetPlanId) {
            const activateResult = await CustomPlan.updateOne(
              { _id: targetPlanId },
              {
                $set: {
                  status: 1,
                  isActive: true,
                  isRefunded: false,
                  paymentId: actualPaymentId,
                  orderId: actualOrderId,
                  invoiceId: actualInvoiceId,
                  refundStatus: null,
                  refundedAt: null,
                  activatedAt: now(),
                  updatedAt: now()
                }
              },
              { session }
            )

            console.log(`📊 Webhook: Activation Result (by ID): ${activateResult.matchedCount > 0 ? 'MATCHED' : 'NOT FOUND'}`)
            if (activateResult.matchedCount > 0) {
              activatedPlanId = targetPlanId
            }
          }

          // 2. Fallback: If ID didn't match, activate the most recent pending plan for this user
          if (!activatedPlanId) {
            console.log('⚠️ Webhook: Update by ID failed or ID not provided, falling back to most recent pending plan...')
            const recentPlan = await CustomPlan.findOne({ userId: targetUserId, status: 0 })
              .sort({ createdAt: -1 })
              .session(session)

            if (recentPlan) {
              await CustomPlan.updateOne(
                { _id: recentPlan._id },
                {
                  $set: {
                    status: 1,
                    isActive: true,
                    isRefunded: false,
                    paymentId: actualPaymentId,
                    orderId: actualOrderId,
                    invoiceId: actualInvoiceId,
                    refundStatus: null,
                    refundedAt: null,
                    activatedAt: now(),
                    updatedAt: now()
                  }
                },
                { session }
              )
              activatedPlanId = recentPlan._id
              console.log('✅ Webhook: Fallback activation SUCCESS for plan:', recentPlan._id)
            }
          }

          // 3. Deactivate other custom plans for this user (ensure ONLY the newly paid plan is active)
          // CRITICAL: Past refunded (status: 5), cancelled (status: 3), or expired (status: 2) plans must NEVER be reactivated!
          // Only previously active (status: 1) plans get marked as deactivated (status: 4).
          if (activatedPlanId) {
            await CustomPlan.updateMany(
              {
                userId: targetUserId,
                _id: { $ne: activatedPlanId },
                status: 1
              },
              {
                $set: {
                  status: 4, // deactivated
                  isActive: false,
                  updatedAt: now()
                }
              },
              { session }
            )

            const cleanupResult = await CustomPlan.updateMany(
              {
                userId: targetUserId,
                _id: { $ne: activatedPlanId },
                isActive: true
              },
              {
                $set: {
                  isActive: false,
                  updatedAt: now()
                }
              },
              { session }
            )
            console.log(`📊 Webhook: Deactivated ${cleanupResult.modifiedCount} old/other plans`)
          }
        } catch (cpErr) {
          console.error('❌ Webhook: Custom plan activation error:', cpErr.message)
        }
      }

      console.log('✅ Webhook: Payment processing completed successfully')
    })
  } catch (error) {
    console.error('❌ Error in handleOrderPaid:', error.message)
    throw error
  }
}

const handleRefundCreated = async (payload) => {
  try {
    const paymentId = payload.refund?.entity?.payment_id || payload.payment?.entity?.id
    if (!paymentId) {
      console.warn('⚠️ handleRefundCreated: Missing paymentId in payload')
      return
    }

    await dbConnect()
    let userId = payload.refund?.entity?.notes?.userId || payload.payment?.entity?.notes?.userId
    if (!userId) {
      const transaction = await Transaction.findOne({ paymentId }).lean()
      if (transaction) userId = transaction.userId
    }

    console.log('💰 Webhook Refund Created for payment:', paymentId)
    await syncRefundsFromRazorpay(paymentId, userId)
  } catch (error) {
    console.error('❌ Error in handleRefundCreated:', error.message)
  }
}

const handleRefundProcessed = async (payload) => {
  try {
    const paymentId = payload.refund?.entity?.payment_id || payload.payment?.entity?.id
    if (!paymentId) {
      console.warn('⚠️ handleRefundProcessed: Missing paymentId in payload')
      return
    }

    await dbConnect()
    let userId = payload.refund?.entity?.notes?.userId || payload.payment?.entity?.notes?.userId
    if (!userId) {
      const transaction = await Transaction.findOne({ paymentId }).lean()
      if (transaction) userId = transaction.userId
    }

    console.log('✅ Webhook Refund Processed for payment:', paymentId)
    await syncRefundsFromRazorpay(paymentId, userId)
  } catch (error) {
    console.error('❌ Error in handleRefundProcessed:', error.message)
  }
}
/** New handler: Handle invoice.paid webhook */
const handleInvoicePaid = async (payload) => {
  try {
    const { invoice } = payload
    if (!invoice || !invoice.entity) {
      throw new Error('Invalid payload: invoice entity missing')
    }

    // Transform invoice entity to look like a payment entity for reusability if possible,
    // or just process it directly here.
    const { id: invoiceId, payment_id: paymentId, amount, currency, notes } = invoice.entity

    console.log('='.repeat(50))
    console.log('💰 HANDLE INVOICE PAID')
    console.log('Invoice ID:', invoiceId)
    console.log('Payment ID:', paymentId)
    console.log('Notes:', JSON.stringify(notes, null, 2))
    console.log('='.repeat(50))

    if (!notes || !notes.userId) {
      console.error('❌ userId is required in invoice notes')
      return // Don't throw to avoid Razorpay retries for invalid data
    }

    // Reuse the same logic as handleOrderPaid but adapt the payload
    // Actually, it's safer to call handleOrderPaid with a shim payload
    await handleOrderPaid({
      payment: {
        entity: {
          id: paymentId,
          amount: amount,
          currency: currency,
          invoice_id: invoiceId,
          order_id: invoice.entity.order_id || '',
          notes: notes,
        },
      },
    })
  } catch (error) {
    console.error('❌ Error in handleInvoicePaid:', error.message)
  }
}

/** New function: Sync all refunds for a user */
const syncUserRefunds = async (userId) => {
  try {
    if (!userId) return 0
    await dbConnect()

    const company = await Company.findOne({ _id: userId }, 'currentPaymentId').lean()

    // Only check transactions that are NOT already fully refunded or processed
    const transactions = await Transaction.find({
      userId: userId,
      type: { $in: [1, 2, 5] }, // Purchase, Upgrade, Renewal
      $or: [
        { status: { $nin: ['refunded'] } },
        { refundStatus: { $ne: 'processed' } },
        { paymentId: company?.currentPaymentId },
      ],
    }).select('paymentId')

    let totalSynced = 0
    const checkedPayments = new Set()

    for (const transaction of transactions) {
      if (!transaction.paymentId || checkedPayments.has(transaction.paymentId)) continue
      checkedPayments.add(transaction.paymentId)
      const refunds = await syncRefundsFromRazorpay(transaction.paymentId, userId)
      totalSynced += refunds.length
    }

    // Also check company's currentPaymentId if not in transactions
    if (company?.currentPaymentId && !checkedPayments.has(company.currentPaymentId)) {
      checkedPayments.add(company.currentPaymentId)
      const refunds = await syncRefundsFromRazorpay(company.currentPaymentId, userId)
      totalSynced += refunds.length
    }

    if (totalSynced > 0) {
      console.log(`✅ Synced ${totalSynced} refunds for user ${userId}`)
    }
    return totalSynced
  } catch (error) {
    console.error('❌ Error syncing user refunds:', error.message)
    return 0
  }
}

/** New function: Get refund details */
const getRefundDetails = async (paymentId, userId = null) => {
  try {
    await dbConnect()

    const query = { paymentId: paymentId }
    if (userId) {
      query.userId = userId
    }

    // Get refunds from our database
    const refunds = await Refund.find(query).sort({ createdAt: -1 })

    // Get original transaction
    const transaction = await Transaction.findOne({
      paymentId: paymentId,
      ...(userId && { userId: userId }),
    })

    // Get refunds from Razorpay for verification
    let razorpayRefunds = []
    try {
      const razorpayData = await razorpay.payments.fetchAllRefunds(paymentId)
      razorpayRefunds = razorpayData.items || []
    } catch (error) {
      console.warn('⚠️ Could not fetch Razorpay refunds:', error.message)
    }

    return {
      transaction,
      refunds,
      razorpayRefunds,
      totalRefunded: refunds.reduce((sum, refund) => sum + refund.amount, 0),
      isFullyRefunded: transaction && transaction.amount && Math.abs(transaction.netAmount) < 0.01, // Account for floating point
    }
  } catch (error) {
    console.error('❌ Error getting refund details:', error.message)
    throw error
  }
}

/** Helper: Handle custom plan specific logic */
const handleCustomPlanPayment = async (userId, paymentId, notes, session) => {
  // Mark the custom plan as paid
  if (notes.customPlanId) {
    await CustomPlan.updateOne(
      { _id: notes.customPlanId, userId: userId },
      {
        status: 1,
        isActive: true,
        isRefunded: false,
        refundStatus: null,
        refundedAt: null,
        paymentId: paymentId || null,
        activatedAt: now(),
        updatedAt: now(),
      },
      { session },
    )

    // Deactivate other custom plans for this user (demote status 1 to status 4 deactivated, preserve status 5 refunded)
    await CustomPlan.updateMany(
      { userId: userId, status: 1, _id: { $ne: notes.customPlanId } },
      { $set: { status: 4, isActive: false, updatedAt: now() } },
      { session },
    )
    await CustomPlan.updateMany(
      { userId: userId, _id: { $ne: notes.customPlanId }, isActive: true },
      { $set: { isActive: false, updatedAt: now() } },
      { session },
    )

    console.log(`✅ Custom plan ${notes.customPlanId} marked as paid and activated`)
  }
}

/** Helper: Fix seat mismatches in existing companies */
const fixSeatMismatches = async (userId) => {
  try {
    await dbConnect()

    const company = await Company.findById(userId)
    if (!company) {
      throw new Error('Company not found')
    }

    console.log(`🔧 Fixing seat mismatches for user ${userId}`)
    console.log(`📊 Current state: Plan: ${company.plan}, Purchased: ${company.seatPurchased}, Capacity: ${company.seatCapacity}`)

    const planInfo = getPlanInfo(company.plan)
    if (!planInfo) {
      console.log('⚠️ No plan info found, cannot fix seats')
      return false
    }

    const totalSeatsFromPlan = planInfo.seat
    const currentTotal = (company.seatPurchased || 0) + (company.seatCapacity || 0)

    console.log(`📊 Plan seats: ${totalSeatsFromPlan}, Current total: ${currentTotal}`)

    if (currentTotal !== totalSeatsFromPlan) {
      console.log(`⚠️ Seat mismatch detected! Fixing...`)

      // Calculate actual used seats from database
      const actualUsedSeats = await Seat.countDocuments({
        companyId: userId,
        status: { $ne: '3' }, // Exclude deleted seats
      })

      console.log(`📊 Actual used seats from DB: ${actualUsedSeats}`)

      // Update company with correct seat counts
      await Company.updateOne(
        { _id: userId },
        {
          totalSeat: totalSeatsFromPlan,
          usedSeat: actualUsedSeats,
          remainingSeat: Math.max(0, totalSeatsFromPlan - actualUsedSeats),
          seatPurchased: actualUsedSeats,
          seatCapacity: Math.max(0, totalSeatsFromPlan - actualUsedSeats),
          updatedAt: now(),
        },
      )

      console.log(`✅ Seat mismatch fixed. Purchased: ${actualUsedSeats}, Capacity: ${totalSeatsFromPlan - actualUsedSeats}`)
      return true
    }

    console.log(`✅ No seat mismatch found`)
    return false
  } catch (error) {
    console.error('❌ Error fixing seat mismatches:', error.message)
    throw error
  }
}

module.exports = {
  handleOrderPaid,
  handleRefundCreated,
  handleRefundProcessed,
  syncRefundsFromRazorpay,
  syncUserRefunds,
  getRefundDetails,
  createRazorpayRefund,
  updateCompanyOnRefund,
  refundOldPlan,
  updateCompanyPlan,
  createLicenseAndNotify,
  // createInvoiceForPayment,
  handleCustomPlanPayment,
  calculateSeatInfo,
  fixSeatMismatches,
  withTransaction,
  recordTransaction,
  recordRefundTransaction,
  handleInvoicePaid,
}

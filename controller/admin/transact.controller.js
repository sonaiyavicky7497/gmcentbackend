const mongoose = require('mongoose')
const jwt = require('jsonwebtoken')
const Company = require('../../models/Company.model')
const Seat = require('../../models/Seat.model')
const dbConnect = require('../../utils/dbConnect')
const { getPlanByNameAndDuration, dateAfterYear, now, dateConverter, dec, getPlanInfo, generateUniqueId } = require('../../utils/utilities')
const Transaction = require('../../models/Transaction.model')
const BillingInfo = require('../../models/BillingInfo.model')
const CustomPlan = require('../../models/CustomPlan.model')
const Razorpay = require('razorpay')
const {
  handleOrderPaid,
  handleRefundCreated,
  handleRefundProcessed,
  handleInvoicePaid,
  refundOldPlan,
  syncRefundsFromRazorpay,
  syncUserRefunds,
} = require('../../utils/trade/paymentHandler')
const Refund = require('../../models/Refund.model') // <-- ADD THIS LINE
// Initialize Razorpay with proper error handling

const axios = require('axios')

// Track currently processing payments to prevent race conditions
const processingPayments = new Set()

/**
 * Create Razorpay invoice via REST API (SAFE + IDEMPOTENT)
 * DO NOT use Razorpay SDK for invoices when headers are needed
 */
const createInvoiceViaAPI = async (payload, idempotencyKey) => {
  const response = await axios.post('https://api.razorpay.com/v1/invoices', payload, {
    auth: {
      username: process.env.RAZORPAY_KEY.trim(),
      password: process.env.RAZORPAY_SECRET.trim(),
    },
    headers: {
      'X-Razorpay-Idempotency-Key': idempotencyKey,
      'Content-Type': 'application/json',
    },
  })

  return response.data
}

let razorpay
try {
  razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY.trim(),
    key_secret: process.env.RAZORPAY_SECRET.trim(),
  })
  console.log('✅ Razorpay initialized successfully')
} catch (error) {
  console.error('❌ Failed to initialize Razorpay:', error.message)
}
// Helper: Normalize country code to 2-letter ISO (default 'in')
const normalizeCountryCode = (country) => {
  if (!country) return 'in'
  const c = String(country).trim().toLowerCase()
  if (c === 'india' || c === 'ind' || c === 'in') return 'in'
  if (c.length === 2) return c
  return 'in'
}

// Helper: Ensure 6-digit postal code for Razorpay Indian address validation
const cleanZipcode = (zipcode, fallback = '395004') => {
  if (!zipcode) return fallback
  const cleaned = String(zipcode).replace(/\s+/g, '').trim()
  if (/^[1-9][0-9]{5}$/.test(cleaned)) {
    return cleaned
  }
  return fallback
}

// Helper function for valid billing address with auto-persistence from Company
const getBillingAddressForUser = async (userId, companyInfo) => {
  try {
    // 1. Try to get from BillingInfo first
    const billingInfo = await BillingInfo.findOne({
      owner: userId,
      isDeleted: false,
    }).lean()

    if (billingInfo && billingInfo.line1 && billingInfo.line1.trim() && billingInfo.city && billingInfo.city.trim()) {
      return {
        line1: billingInfo.line1.trim(),
        line2: (billingInfo.line2 || '').trim(),
        city: billingInfo.city.trim(),
        state: billingInfo.state ? billingInfo.state.trim() : 'Gujarat',
        zipcode: cleanZipcode(billingInfo.zipcode),
        country: normalizeCountryCode(billingInfo.country),
      }
    }

    // 2. Fallback to company info
    if (!companyInfo) {
      companyInfo = await Company.findOne({ _id: userId }, 'companyName address city state country zipcode gstin').lean()
    }

    const zipMatch = companyInfo?.address?.match(/\b[1-9][0-9]{5}\b/)
    const companyZip = cleanZipcode(companyInfo?.zipcode || (zipMatch ? zipMatch[0] : null), '395004')
    const companyCountry = normalizeCountryCode(companyInfo?.country)
    const companyCity = companyInfo?.city?.trim() || 'Surat'
    const companyState = companyInfo?.state?.trim() || 'Gujarat'
    const companyLine1 = companyInfo?.address?.trim() || (companyInfo?.companyName ? `${companyInfo.companyName} Office` : '412, Parle Square')

    // Auto-create BillingInfo in DB if missing so user record is complete and consistent
    try {
      if (userId) {
        await BillingInfo.create({
          owner: userId,
          line1: companyLine1,
          line2: '',
          city: companyCity,
          state: companyState,
          country: companyCountry,
          zipcode: companyZip,
          gstin: companyInfo?.gstin || null,
          createdAt: now(),
        })
        console.log(`✅ Auto-created BillingInfo for user ${userId} from Company address`)
      }
    } catch (createErr) {
      console.warn('⚠️ Could not auto-persist BillingInfo:', createErr.message)
    }

    return {
      line1: companyLine1,
      line2: '',
      city: companyCity,
      state: companyState,
      zipcode: companyZip,
      country: companyCountry,
    }
  } catch (error) {
    console.error('❌ Error in getBillingAddressForUser:', error.message)
    return {
      line1: companyInfo?.address || '412, Parle Square',
      line2: '',
      city: companyInfo?.city || 'Surat',
      state: companyInfo?.state || 'Gujarat',
      zipcode: '395004',
      country: 'in',
    }
  }
}

// Helper: Ensure Razorpay Customer Profile has updated name and clean address list
const ensureRazorpayCustomerAddressesReady = async (userId, companyInfo, customerDetails) => {
  try {
    const { cleanCustomerAddresses, findRazorpayCustomerByEmail } = require('../../utils/razorpay')
    const cleanEmail = customerDetails.email?.trim().toLowerCase()
    let razorpayCustomerId = companyInfo?.razorpayCustomerId

    if (!razorpayCustomerId && cleanEmail) {
      const existing = await findRazorpayCustomerByEmail(cleanEmail)
      if (existing) {
        razorpayCustomerId = existing.id
        if (userId) {
          await Company.updateOne({ _id: userId }, { razorpayCustomerId: existing.id })
        }
      }
    }

    if (razorpayCustomerId && razorpayCustomerId.startsWith('cust_')) {
      // 1. Update customer name in Razorpay to include Company Name and User Name
      try {
        await razorpay.customers.edit(razorpayCustomerId, {
          name: customerDetails.name,
          contact: customerDetails.contact,
          ...(customerDetails.gstin ? { gstin: customerDetails.gstin } : {}),
        })
        console.log(`✅ Updated Razorpay customer ${razorpayCustomerId} profile with name: ${customerDetails.name}`)
      } catch (editErr) {
        console.warn(`⚠️ Could not edit Razorpay customer profile: ${editErr.message}`)
      }

      // 2. Clean stale addresses so Razorpay doesn't hit its address limit and drop invoice addresses
      await cleanCustomerAddresses(razorpayCustomerId)
      return razorpayCustomerId
    }
    return null
  } catch (err) {
    console.warn('⚠️ Error in ensureRazorpayCustomerAddressesReady:', err.message)
    return null
  }
}

// Helper function to get complete customer details for invoice generation
const getCompleteCustomerDetails = async (userId, companyInfo = null) => {
  try {
    // Fetch company info if not provided
    if (!companyInfo) {
      companyInfo = await Company.findOne(
        { _id: userId },
        'fName lName email companyName phone phoneCode address city state country zipcode gstin razorpayCustomerId',
      ).lean()
    }

    if (!companyInfo) {
      console.error('❌ Company info not found for user:', userId)
      return null
    }

    // Get billing address with fallbacks and normalization
    const billingAddress = await getBillingAddressForUser(userId, companyInfo)

    // Clean GSTIN - only include if valid
    let gstin = null
    const billingInfo = await BillingInfo.findOne({
      owner: userId,
      isDeleted: false,
    }).lean()

    if (billingInfo && billingInfo.gstin && billingInfo.gstin.trim() !== '') {
      gstin = billingInfo.gstin.trim()
    } else if (companyInfo.gstin && companyInfo.gstin.trim() !== '') {
      gstin = companyInfo.gstin.trim()
    }

    // Ensure contact is always a valid string
    const phoneCode = companyInfo.phoneCode || '+91'
    const phone = companyInfo.phone || '9999999999'
    const contactNumber = `${phoneCode}${phone}`.replace(/\s+/g, '')

    const address = {
      line1: billingAddress.line1,
      line2: billingAddress.line2 || '',
      city: billingAddress.city,
      state: billingAddress.state,
      zipcode: billingAddress.zipcode,
      country: billingAddress.country,
    }

    // Combine Company Name AND User Name cleanly so both are visible on invoices
    const fName = (companyInfo.fName || '').trim()
    const lName = (companyInfo.lName || '').trim()
    const userName = `${fName} ${lName}`.trim()
    const companyName = (companyInfo.companyName || '').trim()

    let displayName = 'Customer'
    if (companyName && userName) {
      if (companyName.toLowerCase() === userName.toLowerCase()) {
        displayName = companyName
      } else {
        displayName = `${companyName} (${userName})`
      }
    } else if (companyName) {
      displayName = companyName
    } else if (userName) {
      displayName = userName
    }

    // Shipping recipient name
    const shippingRecipientName = companyName ? (userName ? `${companyName} (${userName})` : companyName) : userName || 'Customer'

    const email = companyInfo.email || ''

    const customerDetails = {
      name: displayName,
      companyName: companyName,
      userName: userName,
      email: email,
      contact: contactNumber,
      billing_address: address,
      // shipping_address: {
      //   name: shippingRecipientName,
      //   line1: address.line1,
      //   line2: address.line2 || '',
      //   city: address.city,
      //   state: address.state,
      //   zipcode: address.zipcode,
      //   country: address.country,
      // },
      notes: {
        companyId: userId.toString(),
        companyName: companyName,
        userName: userName,
      },
    }

    // Only include GSTIN if it exists
    if (gstin) {
      customerDetails.gstin = gstin
    }

    console.log('📋 Complete Customer Details Generated:')
    console.log('  Customer Name:', customerDetails.name)
    console.log('  Company Name:', customerDetails.companyName)
    console.log('  User Name:', customerDetails.userName)
    console.log('  Email:', customerDetails.email)
    console.log('  Contact:', customerDetails.contact)
    console.log('  GSTIN:', customerDetails.gstin || 'Not provided')
    console.log('  Billing Address:', JSON.stringify(customerDetails.billing_address, null, 2))
    console.log('  Shipping Address:', JSON.stringify(customerDetails.shipping_address, null, 2))

    return customerDetails
  } catch (error) {
    console.error('❌ Error getting customer details:', error.message)
    console.error('Stack:', error.stack)

    const fallbackName = companyInfo?.companyName
      ? companyInfo?.fName
        ? `${companyInfo.companyName} (${companyInfo.fName} ${companyInfo.lName || ''})`
        : companyInfo.companyName
      : companyInfo?.fName
        ? `${companyInfo.fName} ${companyInfo.lName || ''}`
        : 'Customer'

    const fallbackAddr = {
      line1: companyInfo?.address || '412, Parle Square',
      line2: '',
      city: companyInfo?.city || 'Surat',
      state: companyInfo?.state || 'Gujarat',
      zipcode: '395004',
      country: 'in',
    }

    return {
      name: fallbackName,
      email: companyInfo?.email || '',
      contact: '+919999999999',
      billing_address: fallbackAddr,
      // shipping_address: {
      //   name: fallbackName,
      //   ...fallbackAddr,
      // },
    }
  }
}

/**
 * Create invoice AFTER successful payment
 * SINGLE SOURCE OF TRUTH
 */
const createInvoiceAfterPayment = async ({ orderId, paymentId, planInfo, notes, customerDetails }) => {
  try {
    // Validate customer details
    if (!customerDetails || !customerDetails.billing_address) {
      console.error('❌ Invalid customer details for invoice creation')
      throw new Error('Customer details are incomplete')
    }

    if (notes?.userId) {
      try {
        await ensureRazorpayCustomerAddressesReady(notes.userId, null, customerDetails)
      } catch (syncErr) {
        console.warn('⚠️ ensureRazorpayCustomerAddressesReady in createInvoiceAfterPayment:', syncErr.message)
      }
    }

    const payload = {
      type: 'invoice',
      description: `Invoice for ${notes.planName} plan`,
      customer: {
        name: customerDetails.name,
        email: customerDetails.email,
        contact: customerDetails.contact,
        billing_address: customerDetails.billing_address,
        // shipping_address: customerDetails.shipping_address, // Commented: Only Bill To required
      },
      line_items: [
        {
          name: `${notes.planName} yearly plan`,
          description:
            notes.planName === 'Business'
              ? 'Business yearly subscription with essential premium features for growing organizations.'
              : notes.planName === 'Team'
                ? 'Team yearly subscription with essential premium features for small businesses.'
                : notes.planName === 'Starter'
                  ? 'Starter yearly subscription with essential features for individual professionals.'
                  : `Yearly subscription for ${notes.planName} Plan ${planInfo?.seat || notes.seat || 0} users.`,
          amount: Math.round((planInfo?.price || notes.amount || 0) * 100),
          currency: 'INR',
          quantity: 1,
        },
      ],
      email_notify: 1,
      sms_notify: 1,
      notes: {
        ...notes,
        order_id: orderId,
        payment_id: paymentId,
      },
    }

    // Add GSTIN only if it exists
    if (customerDetails.gstin) {
      payload.customer.gstin = customerDetails.gstin
      console.log('✅ Added GSTIN to invoice:', customerDetails.gstin)
    }

    console.log('📄 Creating invoice with payload:')
    console.log(JSON.stringify(payload, null, 2))

    const invoice = await createInvoiceViaAPI(payload, `invoice_${paymentId || orderId}`)

    console.log('✅ Invoice created successfully:', invoice.id)
    return invoice
  } catch (error) {
    console.error('❌ Error creating invoice after payment:', error.message)
    throw error
  }
}

const purchasePlan = async (req, res) => {
  try {
    const { plan, planDuration, notes } = req.body
    const { id } = req.user

    console.log('🛒 Purchase Plan Request:', {
      plan,
      planDuration,
      notes,
      userId: id,
    })

    await dbConnect()

    const companyInfo = await Company.findOne(
      { _id: id },
      'fName lName plan razorpayCustomerId email companyName phone phoneCode address city state country zipcode gstin',
    ).lean()

    if (!companyInfo) {
      return res.status(404).json({ msg: 'Company not found' })
    }

    if (companyInfo.plan) {
      return res.status(400).json({ msg: 'You already have a plan' })
    }

    const planInfo = getPlanByNameAndDuration(plan, planDuration)
    if (!planInfo) {
      return res.status(400).json({ msg: 'This plan is not active yet' })
    }

    // ✅ FIX 1: Get complete customer details
    const customerDetails = await getCompleteCustomerDetails(id, companyInfo)

    if (!customerDetails) {
      return res.status(500).json({ msg: 'Failed to fetch customer details' })
    }

    // ✅ FIX 2: Validate and clean customer details
    const cleanCustomerDetails = {
      name: customerDetails.name || 'Customer',
      email: customerDetails.email || '',
      contact: customerDetails.contact || '+919999999999',
      billing_address: customerDetails.billing_address || {
        line1: '412, Parle Square',
        line2: '',
        city: 'Surat',
        state: 'Gujarat',
        zipcode: '395004',
        country: 'in',
      },
      // shipping_address: customerDetails.shipping_address || customerDetails.billing_address, // Commented: Only Bill To required
    }

    // ✅ FIX 3: Only include GSTIN if valid and not empty
    if (customerDetails.gstin && customerDetails.gstin.trim() !== '') {
      cleanCustomerDetails.gstin = customerDetails.gstin.trim()
      console.log('✅ Adding GSTIN to invoice:', cleanCustomerDetails.gstin)
    }

    console.log('📋 Clean Customer Details:', JSON.stringify(cleanCustomerDetails, null, 2))

    // Ensure Razorpay customer is ready, name/contact updated, and stale addresses cleared
    let razorpayCustomerId = companyInfo.razorpayCustomerId
    try {
      const readyId = await ensureRazorpayCustomerAddressesReady(id, companyInfo, cleanCustomerDetails)
      if (readyId) {
        razorpayCustomerId = readyId
      }
    } catch (custErr) {
      console.warn('⚠️ ensureRazorpayCustomerAddressesReady warning in purchasePlan:', custErr.message)
    }

    // ✅ FIX 5: Prepare invoice payload with proper validation
    const planDescription =
      plan === 'Business'
        ? 'Business yearly subscription with essential premium features for growing organizations.'
        : plan === 'Team'
          ? 'Team yearly subscription with essential premium features for small businesses.'
          : plan === 'Starter'
            ? 'Starter yearly subscription with essential features for individual professionals.'
            : `Yearly subscription for ${plan} Plan with ${planInfo.seat} users.`

    const expireBy = Math.floor(Date.now() / 1000) + 24 * 60 * 60 // 24 hours from now

    // ✅ FIX 7: Build invoice payload with customer details
    const invoicePayload = {
      type: 'invoice',
      line_items: [
        {
          name: `${plan} Plan`,
          description: planDescription,
          amount: Math.round(planInfo.price * 100), // Convert to paise
          currency: 'INR',
          quantity: 1,
        },
      ],
      sms_notify: 1,
      email_notify: 1,
      expire_by: expireBy,
      description: `Purchase of ${plan} plan`,
      notes: {
        userId: id.toString(),
        planName: plan,
        fname: companyInfo.fName || '',
        lname: companyInfo.lName || '',
        email: companyInfo.email || '',
        companyName: companyInfo.companyName || '',
        endAt: notes?.endAt || dateAfterYear(),
        seat: planInfo.seat,
        isPurchasing: true,
      },
      callback_url: `${process.env.FRONTEND_URI}/managelicense`,
      callback_method: 'get',
      customer: {
        name: cleanCustomerDetails.name,
        email: cleanCustomerDetails.email,
        contact: cleanCustomerDetails.contact,
        billing_address: cleanCustomerDetails.billing_address,
        // shipping_address: cleanCustomerDetails.shipping_address, // Commented: Only Bill To required
      },
    }

    if (cleanCustomerDetails.gstin) {
      invoicePayload.customer.gstin = cleanCustomerDetails.gstin
    }

    console.log('🔄 Creating invoice with Razorpay (via API)...')

    try {
      // Use the safe API helper with idempotency
      const idempotencyKey = `inv_purchase_${id}_${Date.now()}`
      const order = await createInvoiceViaAPI(invoicePayload, idempotencyKey)

      console.log('✅ Invoice created successfully:', {
        id: order.id,
        order_id: order.order_id,
        amount: order.amount,
        status: order.status,
        short_url: order.short_url,
      })

      res.status(200).json({
        status: true,
        data: {
          id: order.order_id || order.id,
          order_id: order.order_id || order.id,
          invoice_id: order.id,
          amount: order.amount,
          currency: order.currency,
          notes: order.notes,
          customer_details: order.customer_details,
          short_url: order.short_url,
          status: order.status,
        },
      })
    } catch (razorpayError) {
      console.error(
        '❌ Razorpay invoice creation error details:',
        razorpayError.response ? JSON.stringify(razorpayError.response.data, null, 2) : razorpayError.message,
      )

      // Provide more specific error message from axios response if available
      let errorMessage = 'Failed to create payment invoice'
      if (razorpayError.response && razorpayError.response.data && razorpayError.response.data.error) {
        errorMessage = razorpayError.response.data.error.description || errorMessage
      } else if (razorpayError.message) {
        errorMessage = razorpayError.message
      }

      return res.status(razorpayError.response ? razorpayError.response.status : 500).json({
        status: false,
        msg: errorMessage,
        details: process.env.NODE_ENV !== 'production' && razorpayError.response ? razorpayError.response.data : undefined,
      })
    }
  } catch (err) {
    console.error('❌ purchasePlan error:', {
      message: err.message,
      stack: err.stack,
      statusCode: err.statusCode,
      error: err.error,
    })

    // Handle Razorpay errors specifically
    if (err.statusCode === 400 && err.error && err.error.description) {
      return res.status(400).json({
        status: false,
        msg: err.error.description,
        details: process.env.NODE_ENV !== 'production' ? err.error : undefined,
      })
    }

    return res.status(500).json({
      msg: 'Something went wrong while creating the payment invoice',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    })
  }
}
const verifyPayment = async (req, res) => {
  const { razorpay_payment_id } = req.body
  const lockKey = `payment_${razorpay_payment_id}`

  try {
    console.log('='.repeat(50))
    console.log('🔐 VERIFY PAYMENT API CALLED', new Date().toISOString())
    console.log('Body:', req.body)

    // Check if this payment is already being processed
    if (processingPayments.has(lockKey)) {
      console.log('⏳ Payment already being processed. Waiting...')
      let waitTime = 0
      while (processingPayments.has(lockKey) && waitTime < 5000) {
        await new Promise((r) => setTimeout(r, 500))
        waitTime += 500
      }
    }

    // Acquire lock
    processingPayments.add(lockKey)

    let { razorpay_order_id, razorpay_signature, razorpay_invoice_id } = req.body
    let id = req.user?.id

    // ✅ DECLARE finalInvoiceId at the beginning
    let finalInvoiceId = null

    // ✅ CRITICAL: Check for duplicate payment processing immediately
    await dbConnect()
    const existingTransaction = await Transaction.findOne({
      paymentId: razorpay_payment_id,
    })

    if (existingTransaction) {
      console.log('⚠️ Payment already processed:', razorpay_payment_id)
      console.log('📄 Existing transaction invoice:', existingTransaction.invoiceId)
      // Get updated company info for response
      const updatedCompany = await Company.findOne(
        { _id: existingTransaction.userId },
        'plan expiredAt seatCapacity seatPurchased currentPaymentId',
      ).lean()

      if (updatedCompany) {
        const totalPlanSeats = updatedCompany.seatPurchased + updatedCompany.seatCapacity
        return res.status(200).json({
          status: true,
          msg: 'Payment already verified and processed',
          data: {
            alreadyProcessed: true,
            paymentId: razorpay_payment_id,
            invoiceId: existingTransaction.invoiceId,
            plan: updatedCompany.plan,
            expiredAt: updatedCompany.expiredAt,
            totalSeat: updatedCompany.totalSeat !== undefined ? updatedCompany.totalSeat : totalPlanSeats,
            usedSeat: updatedCompany.usedSeat !== undefined ? updatedCompany.usedSeat : updatedCompany.seatPurchased,
            remainingSeat: updatedCompany.remainingSeat !== undefined ? updatedCompany.remainingSeat : updatedCompany.seatCapacity,
            seatCapacity: updatedCompany.seatCapacity,
            seatPurchased: updatedCompany.seatPurchased,
            totalPlanSeats: totalPlanSeats,
            usedLicenses: updatedCompany.seatPurchased,
            remainingLicenses: updatedCompany.seatCapacity,
            currentPaymentId: updatedCompany.currentPaymentId,
            isPlanActive: true,
          },
        })
      }
    }

    // Validate input: Need at least payment_id and (order_id OR invoice_id)
    if (!razorpay_payment_id || (!razorpay_order_id && !razorpay_invoice_id)) {
      return res.status(400).json({
        status: false,
        msg: 'Missing payment details',
      })
    }

    // ✅ FIX: Extract invoice ID if frontend mistakenly sent it as order ID
    if (!razorpay_invoice_id && razorpay_order_id && razorpay_order_id.startsWith('inv_')) {
      razorpay_invoice_id = razorpay_order_id
      razorpay_order_id = undefined
    }

    let notes = {}
    let verifiedViaApi = false
    let entityId = razorpay_order_id || razorpay_invoice_id
    let isInvoicePayment = !!razorpay_invoice_id
    let payment = null

    // 1. Backend Verification: Fetch from Razorpay to confirm status
    try {
      if (razorpay_invoice_id) {
        console.log('🔄 Verifying via Invoice API:', razorpay_invoice_id)
        const invoice = await razorpay.invoices.fetch(razorpay_invoice_id)
        if (invoice) {
          finalInvoiceId = invoice.id
          if (invoice.notes && Object.keys(invoice.notes).length > 0) {
            notes = invoice.notes
          }
          if (invoice.status === 'paid') {
            verifiedViaApi = true
          }
          console.log('📄 Invoice notes:', JSON.stringify(notes, null, 2))
          entityId = razorpay_invoice_id
        }
      } else if (razorpay_order_id) {
        console.log('🔄 Verifying via Order API:', razorpay_order_id)
        const order = await razorpay.orders.fetch(razorpay_order_id)
        if (order) {
          // Check payments for this order
          const payments = await razorpay.orders.fetchPayments(razorpay_order_id)
          const successfulPayment = payments.items.find((p) => p.status === 'captured' || p.id === razorpay_payment_id)
          if (successfulPayment && successfulPayment.status === 'captured') {
            verifiedViaApi = true
            if (order.notes && Object.keys(order.notes).length > 0) {
              notes = order.notes
            }
          }
        }
      }
    } catch (apiErr) {
      console.error('❌ API Verification failed:', apiErr.message)
    }

    // 2. Signature Verification (Secondary or Fallback)
    const crypto = require('crypto')
    const secret = process.env.RAZORPAY_SECRET.trim()
    let isValidSignature = false

    if (razorpay_order_id && razorpay_payment_id && razorpay_signature) {
      const body = razorpay_order_id + '|' + razorpay_payment_id
      const generatedSignature = crypto.createHmac('sha256', secret).update(body).digest('hex')
      isValidSignature = generatedSignature === razorpay_signature
    } else if (razorpay_invoice_id && razorpay_payment_id && razorpay_signature) {
      const body1 = razorpay_invoice_id + '|' + razorpay_payment_id
      const sig1 = crypto.createHmac('sha256', secret).update(body1).digest('hex')
      const body2 = razorpay_payment_id + '|' + razorpay_invoice_id
      const sig2 = crypto.createHmac('sha256', secret).update(body2).digest('hex')
      isValidSignature = sig1 === razorpay_signature || sig2 === razorpay_signature
    }

    if (!isValidSignature && !verifiedViaApi) {
      console.error('❌ Payment verification failed')
      return res.status(400).json({
        status: false,
        msg: 'Invalid payment signature',
      })
    }

    // ✅ Fetch payment details to confirm status
    try {
      payment = await razorpay.payments.fetch(razorpay_payment_id)
      if (payment.status !== 'captured') {
        console.error('❌ Payment not captured:', payment.status)
        return res.status(400).json({
          status: false,
          msg: 'Payment not captured yet',
        })
      }
      console.log('💰 Payment details fetched:', payment.id, payment.status, payment.amount / 100, payment.currency)
    } catch (paymentErr) {
      console.error('❌ Error fetching payment:', paymentErr.message)
      return res.status(400).json({
        status: false,
        msg: 'Could not verify payment status',
      })
    }

    // If notes are empty or invoice ID was not provided in request, check payment.invoice_id
    const effectiveInvoiceId = razorpay_invoice_id || (payment && payment.invoice_id)
    if (effectiveInvoiceId && (!notes || Object.keys(notes).length === 0 || !notes.customPlanId)) {
      try {
        console.log('🔄 Fetching invoice for notes & finalInvoiceId:', effectiveInvoiceId)
        const inv = await razorpay.invoices.fetch(effectiveInvoiceId)
        if (inv) {
          finalInvoiceId = inv.id
          if (inv.notes && Object.keys(inv.notes).length > 0) {
            notes = { ...inv.notes, ...notes }
            console.log('📄 Recovered notes from invoice:', JSON.stringify(notes, null, 2))
          }
        }
      } catch (invErr) {
        console.warn('⚠️ Could not fetch invoice for notes:', invErr.message)
      }
    }

    // If user ID is not in request (public call), get it from verified notes
    if (!id && notes.userId) {
      id = notes.userId
      console.log('👤 ID inferred from verified notes:', id)
    }

    if (!id) {
      return res.status(400).json({
        status: false,
        msg: 'User ID not found',
      })
    }

    const planName = notes.planName || 'Starter'
    const isRenewing = notes.isRenewing === true || notes.isRenewing === 'true'
    const isUpgrading = notes.isUpgrading === true || notes.isUpgrading === 'true'
    const isCustomPlan = notes.isCustomPlan === true || notes.isCustomPlan === 'true' || notes.planName === 'Enterprise'
    const customPlanId = notes.customPlanId || notes.planId || null
    const seatCount = notes.seat ? parseInt(notes.seat) : null

    console.log('📊 Payment type detection:')
    console.log('  isCustomPlan:', isCustomPlan)
    console.log('  customPlanId:', customPlanId)
    console.log('  customPlanId type:', typeof customPlanId)
    console.log('  isUpgrading:', isUpgrading)
    console.log('  isRenewing:', isRenewing)

    const planInfo = getPlanByNameAndDuration(planName, 'yearly')

    // Calculate expiry
    let expiredAt
    if (notes.endAt) {
      expiredAt = Number(notes.endAt)
    } else {
      expiredAt = dateAfterYear()
    }

    console.log('📅 Expiry calculated:', expiredAt, new Date(expiredAt * 1000))

    const companyInfo = await Company.findOne({ _id: id }).lean()
    if (!companyInfo) {
      return res.status(404).json({
        status: false,
        msg: 'Company not found',
      })
    }

    // REFUND OLD PLAN FOR UPGRADES
    let refundResult = { success: false, amount: 0 }

    if (isUpgrading && companyInfo.plan && companyInfo.currentPaymentId) {
      console.log('🔄 Processing refund for upgrade...')
      console.log(`📊 Upgrading from ${companyInfo.plan} to ${planName}`)

      try {
        refundResult = await refundOldPlan(companyInfo, notes, id)

        if (refundResult.success) {
          console.log(`✅ Refund processed successfully: ₹${refundResult.amount}`)
        } else {
          console.log(`⚠️ Refund skipped/failed: ${refundResult.reason}`)
        }
      } catch (refundErr) {
        console.error('❌ Error processing refund:', refundErr.message)
        refundResult = { success: false, amount: 0, reason: refundErr.message }
      }
    }

    const session = await Company.startSession()
    session.startTransaction()

    try {
      let totalPlanSeats = planInfo ? planInfo.seat : 2

      // For Custom Plans, ALWAYS use the seat count from notes
      if (isCustomPlan && seatCount) {
        totalPlanSeats = seatCount
      }

      console.log(`🪑 Total seats for calculation: ${totalPlanSeats} (Custom: ${isCustomPlan})`)

      // Set plan data based on scenario
      const setData = {
        plan: planName,
        expiredAt,
        currentPaymentId: razorpay_payment_id,
        updatedAt: now(),
      }

      // First time purchase - admin gets 1 seat allocation and it consumes one seat from the purchased total
      if (!companyInfo.plan && !isRenewing && !isUpgrading) {
        setData.seatPurchased = 0 // User gets all seats
        setData.seatCapacity = totalPlanSeats
        setData.totalSeat = totalPlanSeats
        setData.usedSeat = 0
        setData.remainingSeat = totalPlanSeats
        console.log(`📊 First purchase: totalSeat=${totalPlanSeats}, usedSeat=0, remainingSeat=${totalPlanSeats}`)
      } else if (isCustomPlan) {
        // Custom Plan: Always reset capacity to match the custom total
        const usedSeats = companyInfo.usedSeat !== undefined ? companyInfo.usedSeat : companyInfo.seatPurchased || 0
        const remainingSeats = Math.max(0, totalPlanSeats - usedSeats)
        setData.seatCapacity = remainingSeats
        setData.seatPurchased = usedSeats
        setData.totalSeat = totalPlanSeats
        setData.usedSeat = usedSeats
        setData.remainingSeat = remainingSeats
        console.log(`📊 Custom Plan Reset: totalSeat=${totalPlanSeats}, usedSeat=${usedSeats}, remainingSeat=${remainingSeats}`)
      } else if (isUpgrading && planInfo) {
        // Upgrading - add difference in seats to capacity
        const currentPlanInfo = getPlanInfo(companyInfo.plan)
        const currentTotalSeats = currentPlanInfo ? currentPlanInfo.seat : 0
        const additionalSeats = totalPlanSeats - currentTotalSeats
        const currentRem = companyInfo.remainingSeat !== undefined ? companyInfo.remainingSeat : companyInfo.seatCapacity || 0
        const newRem = currentRem + additionalSeats
        const usedSeats = companyInfo.usedSeat !== undefined ? companyInfo.usedSeat : companyInfo.seatPurchased || 0

        setData.seatCapacity = newRem
        setData.seatPurchased = usedSeats
        setData.totalSeat = totalPlanSeats
        setData.usedSeat = usedSeats
        setData.remainingSeat = newRem
        console.log(`📊 Upgrade: Adding ${additionalSeats} seats to remaining: totalSeat=${totalPlanSeats}, remainingSeat=${newRem}`)
      } else if (isRenewing) {
        // Renewing - reset capacity based on new plan but keep used seats
        const usedSeats = companyInfo.usedSeat !== undefined ? companyInfo.usedSeat : companyInfo.seatPurchased || 0
        const remainingSeats = Math.max(0, totalPlanSeats - usedSeats)
        setData.seatCapacity = remainingSeats
        setData.seatPurchased = usedSeats
        setData.totalSeat = totalPlanSeats
        setData.usedSeat = usedSeats
        setData.remainingSeat = remainingSeats
        console.log(`📊 Renewal: totalSeat=${totalPlanSeats}, usedSeat=${usedSeats}, remainingSeat=${remainingSeats}`)
      }

      await Company.updateOne({ _id: id }, { $set: setData }, { session })

      // ✅ INVOICE HANDLING LOGIC - PREVENT DUPLICATES
      // Initialize finalInvoiceId if not already set
      if (!finalInvoiceId) {
        const existingInvoices = await razorpay.invoices.all({
          payment_id: razorpay_payment_id,
          count: 1,
        })

        if (existingInvoices.items && existingInvoices.items.length > 0) {
          finalInvoiceId = existingInvoices.items[0].id
        } else {
          const customerDetails = await getCompleteCustomerDetails(id)
          const invoice = await createInvoiceAfterPayment({
            orderId: razorpay_order_id,
            paymentId: razorpay_payment_id,
            planInfo,
            notes: {
              ...notes,
              userId: id,
              isRenewing,
              isUpgrading,
              isCustomPlan,
              customPlanId,
            },
            customerDetails,
          })
          finalInvoiceId = invoice.id
        }
      }

      // Check for duplicate transaction
      const duplicateCheck = await Transaction.findOne({
        paymentId: razorpay_payment_id,
      }).session(session)

      if (duplicateCheck) {
        await session.abortTransaction()
        // Return success since payment was already processed
        const alreadyUpdatedCompany = await Company.findOne({ _id: id }, 'plan expiredAt seatCapacity seatPurchased currentPaymentId').lean()
        return res.status(200).json({
          status: true,
          msg: 'Payment already processed',
          data: {
            alreadyProcessed: true,
            paymentId: razorpay_payment_id,
            invoiceId: duplicateCheck.invoiceId,
            plan: alreadyUpdatedCompany.plan,
            expiredAt: alreadyUpdatedCompany.expiredAt,
            totalSeat:
              alreadyUpdatedCompany.totalSeat !== undefined
                ? alreadyUpdatedCompany.totalSeat
                : alreadyUpdatedCompany.seatPurchased + alreadyUpdatedCompany.seatCapacity,
            usedSeat: alreadyUpdatedCompany.usedSeat !== undefined ? alreadyUpdatedCompany.usedSeat : alreadyUpdatedCompany.seatPurchased,
            remainingSeat:
              alreadyUpdatedCompany.remainingSeat !== undefined ? alreadyUpdatedCompany.remainingSeat : alreadyUpdatedCompany.seatCapacity,
            seatCapacity: alreadyUpdatedCompany.seatCapacity,
            seatPurchased: alreadyUpdatedCompany.seatPurchased,
            totalPlanSeats: alreadyUpdatedCompany.seatPurchased + alreadyUpdatedCompany.seatCapacity,
          },
        })
      }

      // ✅ Record transaction with proper invoice ID
      const transaction = new Transaction({
        userId: id,
        invoiceId: finalInvoiceId,
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        razorpayInvoiceId: razorpay_invoice_id,
        amount: payment.amount / 100,
        plan: planName,
        type: isRenewing ? 5 : isUpgrading ? 2 : 1,
        currency: payment.currency || 'INR',
        isInvoicePayment: isInvoicePayment,
        status: 'completed',
        upgradeRefundAmount: refundResult.success ? refundResult.amount : 0,
        upgradeRefundId: refundResult.refundId || null,
        createdAt: now(),
        updatedAt: now(),
      })

      await transaction.save({ session })
      console.log(`💾 Transaction saved with invoice ID: ${finalInvoiceId}`)

      // ==========================================
      // ✅ PROPER CUSTOM PLAN ACTIVATION
      // ==========================================
      const effectiveCustomPlanId = customPlanId || notes.customPlanId || notes.planId || req.body.customPlanId
      if (isCustomPlan === true || isCustomPlan === 'true' || notes.planName === 'Enterprise' || effectiveCustomPlanId) {
        console.log('🔄 verifyPayment: Updating custom plan status for planId:', effectiveCustomPlanId)
        try {
          const ObjectId = mongoose.Types.ObjectId

          // Ensure IDs are ObjectIds for accurate matching
          const targetPlanId = effectiveCustomPlanId && ObjectId.isValid(effectiveCustomPlanId) ? new ObjectId(effectiveCustomPlanId) : null
          const targetUserId = ObjectId.isValid(id) ? new ObjectId(id) : id

          const actualPaymentId = razorpay_payment_id || (payment && payment.id) || null
          const actualOrderId = razorpay_order_id || (payment && payment.order_id) || null
          const actualInvoiceId = finalInvoiceId || razorpay_invoice_id || (payment && payment.invoice_id) || null

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
                  updatedAt: now(),
                },
              },
              { session },
            )

            console.log(`📊 verifyPayment: Activation Result (by ID): ${activateResult.matchedCount > 0 ? 'MATCHED' : 'NOT FOUND'}`)
            if (activateResult.matchedCount > 0) {
              activatedPlanId = targetPlanId
            }
          }

          // 2. Fallback: If ID didn't match or wasn't provided, activate the most recent pending plan (status: 0) for this user
          if (!activatedPlanId) {
            console.log('⚠️ verifyPayment: Update by ID failed or ID not provided, falling back to recent pending plan...')
            const recentPlan = await CustomPlan.findOne({ userId: targetUserId, status: 0 }).sort({ createdAt: -1 }).session(session)

            if (recentPlan) {
              console.log('📋 Found recent pending plan:', recentPlan._id)
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
                    updatedAt: now(),
                  },
                },
                { session },
              )
              activatedPlanId = recentPlan._id
              console.log('✅ verifyPayment: Fallback activation SUCCESS for plan:', recentPlan._id)
            }
          }

          // 3. Deactivate other custom plans for this user (ensure ONLY the newly paid plan is active)
          // CRITICAL: Past refunded (status: 5), cancelled (status: 3), or expired (status: 2) plans must NEVER be reactivated!
          // Only previously active (status: 1) plans get marked as deactivated (status: 4).
          if (activatedPlanId) {
            // Any other previously paid plan is now marked deactivated (status: 4)
            await CustomPlan.updateMany(
              {
                userId: targetUserId,
                _id: { $ne: activatedPlanId },
                status: 1,
              },
              {
                $set: {
                  status: 4, // deactivated
                  isActive: false,
                  updatedAt: now(),
                },
              },
              { session },
            )

            // Ensure isActive is false for ALL other plans regardless of their status
            const cleanupResult = await CustomPlan.updateMany(
              {
                userId: targetUserId,
                _id: { $ne: activatedPlanId },
                isActive: true,
              },
              {
                $set: {
                  isActive: false,
                  updatedAt: now(),
                },
              },
              { session },
            )
            console.log(`📊 verifyPayment: Deactivated ${cleanupResult.modifiedCount} other plans`)
          }
        } catch (cpErr) {
          console.error('❌ verifyPayment: Custom plan activation error:', cpErr)
        }
      }

      // First-time purchase - create or reset the admin seat as pending
      /*
      if (!companyInfo.plan && !isRenewing && !isUpgrading) {
        const normalizedAdminEmail = companyInfo.email ? companyInfo.email.trim().toLowerCase() : null
        const existingAdminSeat = normalizedAdminEmail
          ? await Seat.findOne({
              companyId: id,
              email: normalizedAdminEmail,
              status: { $in: ['0', '1'] },
            }).session(session)
          : null

        if (existingAdminSeat) {
          await Seat.updateOne(
            { _id: existingAdminSeat._id },
            {
              $set: {
                companyId: id,
                fname: companyInfo.fName || 'Admin',
                lname: companyInfo.lName || 'User',
                email: normalizedAdminEmail || companyInfo.email,
                role: 'Admin',
                status: '0',
                createdAt: now(),
              },
            },
            { session },
          )
          console.log('ℹ️ Admin seat updated to pending:', existingAdminSeat.license)
        } else {
          const license = generateUniqueId()
          const adminSeat = new Seat({
            companyId: id,
            fname: companyInfo.fName || 'Admin',
            lname: companyInfo.lName || 'User',
            email: normalizedAdminEmail || companyInfo.email,
            license,
            role: 'Admin',
            status: '0',
            createdAt: now(),
            updatedAt: now(),
          })
          await adminSeat.save({ session })
          console.log('👤 Admin seat created with license:', license)
        }
      }
      */

      await session.commitTransaction()
      console.log('✅ Database transaction committed successfully')
    } catch (err) {
      await session.abortTransaction()
      console.error('❌ Transaction error:', err)
      console.error('Stack trace:', err.stack)
      throw err
    } finally {
      await session.endSession()
    }

    const updatedCompany = await Company.findOne({ _id: id }, 'plan expiredAt seatCapacity seatPurchased currentPaymentId').lean()
    const totalPlanSeats = updatedCompany.seatPurchased + updatedCompany.seatCapacity

    console.log('='.repeat(50))
    console.log('✅ PAYMENT VERIFIED AND PLAN ACTIVATED')
    console.log('Updated company:', updatedCompany)
    console.log('Total licenses from plan:', totalPlanSeats)
    console.log('='.repeat(50))

    res.status(200).json({
      status: true,
      msg: 'Payment verified and plan activated successfully!',
      data: {
        paymentId: razorpay_payment_id,
        orderId: razorpay_order_id,
        invoiceId: finalInvoiceId,
        plan: updatedCompany.plan,
        expiredAt: updatedCompany.expiredAt,
        totalSeat: updatedCompany.totalSeat !== undefined ? updatedCompany.totalSeat : totalPlanSeats,
        usedSeat: updatedCompany.usedSeat !== undefined ? updatedCompany.usedSeat : updatedCompany.seatPurchased,
        remainingSeat: updatedCompany.remainingSeat !== undefined ? updatedCompany.remainingSeat : updatedCompany.seatCapacity,
        seatCapacity: updatedCompany.seatCapacity,
        seatPurchased: updatedCompany.seatPurchased,
        totalPlanSeats: totalPlanSeats,
        usedLicenses: updatedCompany.seatPurchased,
        remainingLicenses: updatedCompany.seatCapacity,
        currentPaymentId: updatedCompany.currentPaymentId,
        isPlanActive: true,
        isInvoicePayment: isInvoicePayment,
      },
    })
  } catch (err) {
    console.error('❌ verifyPayment error:', err)
    if (!res.headersSent) {
      return res.status(500).json({ status: false, msg: 'Payment verification failed' })
    }
  } finally {
    if (lockKey) processingPayments.delete(lockKey)
  }
}

// Update paymentWebhook to handle invoice creation
const paymentWebhook = async (req, res) => {
  let lockKey = null
  try {
    const signature = req.headers['x-razorpay-signature']
    const bodyStr = req.body.toString()
    const isValid = Razorpay.validateWebhookSignature(bodyStr, signature, process.env.RAZORPAY_WEBHOOK_SECRET)

    if (!isValid) {
      console.error('❌ Invalid Webhook Signature')
      return res.status(400).send('Invalid signature')
    }

    const { event, payload } = JSON.parse(bodyStr)
    console.log('🔵 Webhook Event:', event)

    // Detect payment ID from various possible payload structures
    const paymentId = payload.payment?.entity?.id || payload.invoice?.entity?.payment_id || payload.refund?.entity?.payment_id
    if (paymentId) {
      lockKey = `payment_${paymentId}`
      if (processingPayments.has(lockKey)) {
        console.log(`⏳ Webhook: Payment ${paymentId} is already being processed. skipping this duplicate event (${event}).`)
        return res.status(200).send('Processing')
      }
      processingPayments.add(lockKey)
    }

    switch (event) {
      case 'payment.captured':
        // Optional: track captured status
        break
      case 'order.paid':
        await handleOrderPaid(payload)
        break
      case 'refund.created':
        await handleRefundCreated(payload)
        break
      case 'refund.processed':
        await handleRefundProcessed(payload)
        break
      case 'invoice.paid':
        await handleInvoicePaid(payload)
        break
      default:
        console.log(`⚠️ Unhandled webhook event: ${event}`)
        break
    }

    res.status(200).send('OK')
  } catch (err) {
    console.log(`❌ paymentWebhook error`, err)
    res.status(500).send()
  } finally {
    if (lockKey) {
      processingPayments.delete(lockKey)
    }
  }
}
// Local dummy handleInvoicePaid removed, now using the one from paymentHandler.js

const getInvoices = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()

    // Fast sync: check active payment synchronously, sync others in background without blocking response
    try {
      const company = await Company.findOne({ _id: id }, 'currentPaymentId').lean()
      if (company?.currentPaymentId) {
        await syncRefundsFromRazorpay(company.currentPaymentId, id)
      }
      syncUserRefunds(id).catch((e) => console.warn('⚠️ Background syncUserRefunds warning:', e.message))
    } catch (syncErr) {
      console.warn('⚠️ syncUserRefunds warning in getInvoices:', syncErr.message)
    }

    const { sortBy, order, limit, page, billingFilter, showRefunds = false } = req.query
    const sortField = ['createdAt', 'invoiceId', 'paymentId', 'plan', 'amount', 'type', 'status']
    const currentYear = new Date().getFullYear()
    const startOfYear = new Date(`${currentYear}-01-01T00:00:00Z`).getTime() / 1000
    const endOfYear = new Date(`${currentYear + 1}-01-01T00:00:00Z`).getTime() / 1000
    const dynamicQry = { userId: id }
    if (billingFilter == 1) dynamicQry.createdAt = { $gte: startOfYear, $lt: endOfYear }
    // Filter by transaction type
    if (!showRefunds) {
      dynamicQry.type = { $in: [1, 2, 5] } // Only show purchases, upgrades, renewals
    }
    const txnHistory = await Transaction.find(dynamicQry, { _id: 0, userEmail: 0 })
      .skip(page * limit)
      .limit(parseInt(limit))
      .sort({ [sortField[sortBy]]: 1 * order })
      .lean()
    // Populate billing details for each transaction
    const enrichedTxnHistory = await Promise.all(
      txnHistory.map(async (txn) => {
        const userId = txn.userId || id
        const companyInfo = await Company.findOne(
          { _id: userId },
          'fName lName email phone phoneCode companyName address city state country zipcode',
        ).lean()
        const billingInfo = await BillingInfo.findOne({ owner: userId, isDeleted: false }).lean()
        let addressDetails = {}
        if (billingInfo) {
          addressDetails = {
            address: billingInfo.line1 + (billingInfo.line2 ? ', ' + billingInfo.line2 : ''),
            city: billingInfo.city,
            state: billingInfo.state,
            country: billingInfo.country,
            zipcode: billingInfo.zipcode,
          }
        } else if (companyInfo) {
          addressDetails = {
            address: companyInfo.address,
            city: companyInfo.city,
            state: companyInfo.state,
            country: companyInfo.country,
            zipcode: companyInfo.zipcode || '',
          }
        }
        // Get refund details for this transaction (with error handling)
        let refundDetails = null
        if (txn.refundAmount > 0) {
          try {
            // Check if Refund model exists
            if (typeof Refund !== 'undefined') {
              const refunds = await Refund.find({ paymentId: txn.paymentId }).sort({ createdAt: -1 })
              refundDetails = {
                totalRefunded: txn.refundAmount,
                isFullyRefunded: Math.abs(txn.netAmount) < 0.01,
                refunds: refunds.map((refund) => ({
                  id: refund.razorpayRefundId,
                  amount: refund.amount,
                  status: refund.status,
                  reason: refund.reason,
                  createdAt: refund.createdAt,
                  processedAt: refund.updatedAt,
                })),
              }
            } else {
              // If Refund model doesn't exist, create basic refund details
              refundDetails = {
                totalRefunded: txn.refundAmount,
                isFullyRefunded: Math.abs(txn.netAmount) < 0.01,
                refunds: [],
              }
            }
          } catch (refundError) {
            console.warn('⚠️ Error fetching refund details:', refundError.message)
            // Create basic refund details if there's an error
            refundDetails = {
              totalRefunded: txn.refundAmount,
              isFullyRefunded: Math.abs(txn.netAmount) < 0.01,
              refunds: [],
            }
          }
        }
        return {
          ...txn,
          fName: companyInfo ? companyInfo.fName : '',
          lName: companyInfo ? companyInfo.lName : '',
          email: companyInfo ? companyInfo.email : '',
          phone: companyInfo ? companyInfo.phone : '',
          phoneCode: companyInfo ? companyInfo.phoneCode : '',
          companyName: companyInfo ? companyInfo.companyName : '',
          ...addressDetails,
          refundDetails,
          netAmount: txn.netAmount || txn.amount,
        }
      }),
    )
    const txnCount = await Transaction.countDocuments(dynamicQry)
    return res.status(200).json({
      status: true,
      data: {
        invoices: enrichedTxnHistory,
        txnCount,
        showRefunds: showRefunds === 'true',
      },
    })
  } catch (err) {
    console.log('❌ getInvoices', err)
    // Provide more specific error messages
    let errorMsg = 'Something went wrong'
    if (err.message.includes('Refund is not defined')) {
      errorMsg = 'Database model configuration issue. Please contact support.'
      console.error('❌ Refund model not found. Did you create the Refund model file?')
    }
    return res.status(500).json({
      status: false,
      msg: errorMsg,
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
    })
  }
}
const getInvoiceUrl = async (req, res) => {
  try {
    const { invoiceId } = req.body
    if (!invoiceId) return res.status(400).json({ msg: 'Invalid invoice id' })

    console.log('📄 Fetching invoice URL for:', invoiceId)

    if (!razorpay) {
      console.error('❌ getInvoiceUrl: Razorpay not initialized')
      return res.status(500).json({ msg: 'Payment gateway not configured' })
    }

    let invoice
    try {
      // First try to fetch as invoice
      invoice = await razorpay.invoices.fetch(invoiceId)
      console.log('📄 Invoice fetched:', invoice.id)
      console.log('📄 Invoice status:', invoice.status)
      console.log('👤 Invoice customer details:', JSON.stringify(invoice.customer_details, null, 2))

      // ✅ NEW: Extract userId from invoice notes to fetch fresh customer details
      let enhancedCustomerDetails = invoice.customer_details || null

      if (invoice.notes && invoice.notes.userId) {
        try {
          await dbConnect() // Ensure DB connection is active
          const userId = invoice.notes.userId
          console.log('🔍 Fetching fresh customer details for user:', userId)

          // Fetch fresh customer details from database
          const freshCustomerDetails = await getCompleteCustomerDetails(userId)

          if (freshCustomerDetails) {
            enhancedCustomerDetails = {
              name: freshCustomerDetails.name,
              companyName: freshCustomerDetails.companyName,
              userName: freshCustomerDetails.userName,
              email: freshCustomerDetails.email,
              contact: freshCustomerDetails.contact,
              gstin: freshCustomerDetails.gstin || invoice.customer_details?.gstin || null,
              billing_address: freshCustomerDetails.billing_address || invoice.customer_details?.billing_address || null,
              // shipping_address: freshCustomerDetails.shipping_address || invoice.customer_details?.shipping_address || null, // Commented: Only Bill To required
            }

            console.log('✅ Enhanced customer details with fresh data')
            console.log('  Company Name:', enhancedCustomerDetails.companyName || 'Not provided')
            console.log('  User Name:', enhancedCustomerDetails.userName || 'Not provided')
            console.log('  GSTIN:', enhancedCustomerDetails.gstin || 'Not provided')
            console.log('  Billing Address:', enhancedCustomerDetails.billing_address?.line1 || 'Not provided')
          }
        } catch (detailsErr) {
          console.warn('⚠️ Could not fetch fresh customer details:', detailsErr.message)
          // Fall back to invoice customer details
        }
      }

      // ✅ Determine if payment button should be shown
      let shouldShowPaymentButton = false
      let isPaid = false

      switch (invoice.status) {
        case 'issued':
          shouldShowPaymentButton = true
          isPaid = false
          break
        case 'partially_paid':
          shouldShowPaymentButton = true
          isPaid = false
          break
        case 'paid':
          shouldShowPaymentButton = false
          isPaid = true
          break
        case 'cancelled':
        case 'expired':
          shouldShowPaymentButton = false
          isPaid = false
          break
        default:
          shouldShowPaymentButton = false
          isPaid = false
      }

      console.log(`🔄 Invoice Status: ${invoice.status}, Show Payment Button: ${shouldShowPaymentButton}, Is Paid: ${isPaid}`)

      // Return invoice URL if available
      if (invoice.short_url) {
        return res.status(200).json({
          status: true,
          data: {
            url: invoice.short_url,
            customer_details: enhancedCustomerDetails,
            companyName: enhancedCustomerDetails?.companyName || null,
            userName: enhancedCustomerDetails?.userName || null,
            invoice_status: invoice.status,
            shouldShowPaymentButton: shouldShowPaymentButton,
            isPaid: isPaid,
            payment_id: invoice.payment_id || null,
            amount: invoice.amount ? invoice.amount / 100 : 0,
            currency: invoice.currency || 'INR',
            // Additional details for frontend display
            has_gstin: !!enhancedCustomerDetails?.gstin,
            has_billing_address: !!enhancedCustomerDetails?.billing_address?.line1,
          },
        })
      } else if (invoice.status === 'paid' && invoice.payment_id) {
        // If invoice is paid but no short_url, provide payment link
        return res.status(200).json({
          status: true,
          data: {
            url: `https://dashboard.razorpay.com/app/payments/${invoice.payment_id}`,
            isPaymentLink: true,
            customer_details: enhancedCustomerDetails,
            companyName: enhancedCustomerDetails?.companyName || null,
            userName: enhancedCustomerDetails?.userName || null,
            invoice_status: invoice.status,
            shouldShowPaymentButton: false,
            isPaid: true,
            payment_id: invoice.payment_id,
            amount: invoice.amount ? invoice.amount / 100 : 0,
            currency: invoice.currency || 'INR',
            has_gstin: !!enhancedCustomerDetails?.gstin,
            has_billing_address: !!enhancedCustomerDetails?.billing_address?.line1,
          },
        })
      } else {
        return res.status(404).json({
          msg: 'Invoice URL not available',
          invoice_status: invoice.status,
          shouldShowPaymentButton: shouldShowPaymentButton,
          isPaid: false,
          customer_details: enhancedCustomerDetails,
        })
      }
    } catch (invoiceErr) {
      console.log('⚠️ Not an invoice ID, trying to fetch as order:', invoiceErr.message)

      try {
        // If it's an order ID, try to get the associated payment
        const order = await razorpay.orders.fetch(invoiceId)

        // Get payments for this order
        const payments = await razorpay.orders.fetchPayments(invoiceId)

        if (payments && payments.items && payments.items.length > 0) {
          const payment = payments.items[0]
          const isPaid = payment.status === 'captured'
          const shouldShowPaymentButton = !isPaid

          // ✅ NEW: Try to get fresh customer details from order notes
          let customerDetails = null
          if (order.notes && order.notes.userId) {
            try {
              await dbConnect()
              customerDetails = await getCompleteCustomerDetails(order.notes.userId)
              console.log('✅ Fetched customer details from order notes')
            } catch (err) {
              console.warn('⚠️ Could not fetch customer details from order:', err.message)
            }
          }

          // Try to find invoice by payment ID
          const invoiceList = await razorpay.invoices.all({
            payment_id: payment.id,
            count: 1,
          })

          if (invoiceList.items && invoiceList.items.length > 0) {
            // Found associated invoice
            const associatedInvoice = invoiceList.items[0]

            // Merge customer details
            const mergedCustomerDetails = customerDetails || associatedInvoice.customer_details || null

            return res.status(200).json({
              status: true,
              data: {
                url: associatedInvoice.short_url || `https://dashboard.razorpay.com/app/payments/${payment.id}`,
                isPaymentLink: !associatedInvoice.short_url,
                customer_details: mergedCustomerDetails,
                invoice_status: associatedInvoice.status,
                shouldShowPaymentButton: shouldShowPaymentButton,
                isPaid: isPaid,
                payment_id: payment.id,
                amount: payment.amount ? payment.amount / 100 : 0,
                currency: payment.currency || 'INR',
                has_gstin: !!mergedCustomerDetails?.gstin,
                has_billing_address: !!mergedCustomerDetails?.billing_address?.line1,
              },
            })
          } else {
            // No invoice found, return payment link with customer details
            return res.status(200).json({
              status: true,
              data: {
                url: `https://dashboard.razorpay.com/app/payments/${payment.id}`,
                isPaymentLink: true,
                customer_details: customerDetails,
                shouldShowPaymentButton: shouldShowPaymentButton,
                isPaid: isPaid,
                payment_status: payment.status,
                payment_id: payment.id,
                amount: payment.amount ? payment.amount / 100 : 0,
                currency: payment.currency || 'INR',
                has_gstin: !!customerDetails?.gstin,
                has_billing_address: !!customerDetails?.billing_address?.line1,
              },
            })
          }
        } else {
          return res.status(404).json({
            msg: 'No payment found for this order',
            shouldShowPaymentButton: false,
            isPaid: false,
          })
        }
      } catch (orderErr) {
        console.error('❌ Error fetching order:', orderErr.message)
        return res.status(404).json({
          msg: 'Invoice not found',
          shouldShowPaymentButton: false,
          isPaid: false,
        })
      }
    }
  } catch (err) {
    console.log('❌ getInvoiceUrl error:', err.message)
    res.status(500).json({
      status: false,
      msg: 'Failed to fetch invoice. Please try again.',
    })
  }
}
const getCurrentPlanInfo = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()
    const companyInfo = await Company.findOne(
      { _id: id },
      {
        _id: 0,
        expiredAt: 1,
        totalSeat: 1,
        usedSeat: 1,
        remainingSeat: 1,
        seatCapacity: 1,
        plan: 1,
        seatPurchased: 1,
        currentPaymentId: 1,
        companyName: 1,
        email: 1,
        logo: 1,
      },
    ).lean()
    if (!companyInfo) {
      return res.status(404).json({
        status: false,
        msg: 'Company not found',
      })
    }
    // If no plan, return basic company info with plan status as false
    if (!companyInfo.plan) {
      return res.status(200).json({
        status: true,
        data: {
          ...companyInfo,
          plan: null,
          hasPlan: false,
          totalSeat: 0,
          usedSeat: 0,
          remainingSeat: 0,
          seatPurchased: 0,
          seatCapacity: 0,
          totalLicenses: 0,
          usedLicenses: 0,
          remainingLicenses: 0,
          expiredAt: null,
          amount: 0,
        },
      })
    }

    // ✅ NEW: Auto-deactivate expired Custom Plan document
    if (companyInfo.plan === 'Enterprise' && companyInfo.expiredAt && companyInfo.expiredAt < now()) {
      await CustomPlan.updateMany({ userId: id, isActive: true }, { $set: { status: 2, isActive: false, updatedAt: now() } })
      console.log(`📉 Custom plan for user ${id} deactivated due to expiry.`)
    }
    let planDetail = {}
    if (companyInfo.currentPaymentId) {
      try {
        planDetail = await razorpay.payments.fetch(companyInfo.currentPaymentId)
        // If this payment has been refunded in Razorpay, sync and revoke plan immediately!
        if (planDetail && (planDetail.amount_refunded > 0 || planDetail.refund_status)) {
          console.log(`🚨 Active plan payment ${companyInfo.currentPaymentId} is refunded in Razorpay. Revoking plan...`)
          await syncRefundsFromRazorpay(companyInfo.currentPaymentId, id)
          return res.status(200).json({
            status: true,
            data: {
              ...companyInfo,
              plan: null,
              hasPlan: false,
              totalSeat: 0,
              usedSeat: 0,
              remainingSeat: 0,
              seatPurchased: 0,
              seatCapacity: 0,
              totalLicenses: 0,
              usedLicenses: 0,
              remainingLicenses: 0,
              expiredAt: null,
              amount: 0,
            },
          })
        }
      } catch (err) {
        console.log('Could not fetch payment details:', err.message)
      }
    }
    // Get plan info to calculate total licenses
    const planInfo = getPlanInfo(companyInfo.plan)
    if (!planInfo) {
      const usedSeat = companyInfo.usedSeat !== undefined ? Number(companyInfo.usedSeat) : Number(companyInfo.seatPurchased) || 0
      const remainingSeat = companyInfo.remainingSeat !== undefined ? Number(companyInfo.remainingSeat) : Number(companyInfo.seatCapacity) || 0
      const totalSeat = companyInfo.totalSeat !== undefined ? Number(companyInfo.totalSeat) : usedSeat + remainingSeat
      return res.status(200).json({
        status: true,
        data: {
          ...companyInfo,
          expiredAt: companyInfo.expiredAt,
          amount: planDetail.amount || 0,
          totalSeat: totalSeat,
          usedSeat: usedSeat,
          remainingSeat: remainingSeat,
          totalLicenses: totalSeat,
          usedLicenses: usedSeat,
          remainingLicenses: remainingSeat,
          hasPlan: true,
        },
      })
    }
    const usedSeat = companyInfo.usedSeat !== undefined ? Number(companyInfo.usedSeat) : Number(companyInfo.seatPurchased) || 0
    const totalPlanSeats =
      planInfo.seat || (companyInfo.totalSeat !== undefined ? companyInfo.totalSeat : usedSeat + (Number(companyInfo.seatCapacity) || 0))
    const seatPurchased = usedSeat
    const seatCapacity = companyInfo.remainingSeat !== undefined ? Number(companyInfo.remainingSeat) : Number(companyInfo.seatCapacity) || 0
    // Ensure consistency: totalPlanSeats should equal usedSeat + remainingSeat
    const calculatedTotal = seatPurchased + seatCapacity
    if (calculatedTotal !== totalPlanSeats || companyInfo.totalSeat !== totalPlanSeats) {
      console.warn(
        `⚠️ License count mismatch: usedSeat(${seatPurchased}) + remainingSeat(${seatCapacity}) = ${calculatedTotal}, but plan seats = ${totalPlanSeats}`,
      )
      // Validate totalPlanSeats before attempting arithmetic to avoid NaN
      if (typeof totalPlanSeats !== 'number' || Number.isNaN(totalPlanSeats)) {
        console.warn('⚠️ Cannot auto-correct seatCapacity: plan seat count is not a valid number. Skipping DB update.')
      } else {
        // Auto-correct by adjusting remainingSeat
        const correctedSeatCapacity = Math.max(0, Number(totalPlanSeats) - seatPurchased)
        if (!Number.isFinite(correctedSeatCapacity) || Number.isNaN(correctedSeatCapacity)) {
          console.warn('⚠️ Computed correctedSeatCapacity is invalid. Skipping DB update.')
        } else {
          console.log(`🔧 Auto-correcting: remainingSeat = ${totalPlanSeats} - ${seatPurchased} = ${correctedSeatCapacity}`)
          // Update the database
          await Company.updateOne(
            { _id: id },
            {
              totalSeat: totalPlanSeats,
              usedSeat: seatPurchased,
              remainingSeat: correctedSeatCapacity,
              seatCapacity: correctedSeatCapacity,
              seatPurchased: seatPurchased,
              updatedAt: now(),
            },
          )
          companyInfo.totalSeat = totalPlanSeats
          companyInfo.usedSeat = seatPurchased
          companyInfo.remainingSeat = correctedSeatCapacity
          companyInfo.seatCapacity = correctedSeatCapacity
        }
      }
    }
    res.status(200).json({
      status: true,
      data: {
        ...companyInfo,
        expiredAt: companyInfo.expiredAt,
        amount: planDetail.amount || 0,
        totalSeat: totalPlanSeats,
        usedSeat: seatPurchased,
        remainingSeat: companyInfo.remainingSeat !== undefined ? companyInfo.remainingSeat : totalPlanSeats - seatPurchased,
        totalLicenses: totalPlanSeats,
        totalPlanSeats: totalPlanSeats,
        usedLicenses: seatPurchased,
        remainingLicenses: companyInfo.seatCapacity,
        hasPlan: true,
      },
    })
  } catch (err) {
    console.log('❌ getCurrentPlanInfo err', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}
const upgradeSubscription = async (req, res) => {
  try {
    const { switchTo, duration } = req.body
    const { id } = req.user
    await dbConnect()
    const companyInfo = await Company.findOne(
      { _id: id },
      'plan razorpayCustomerId fName lName email expiredAt seatPurchased seatCapacity companyName phone phoneCode address city state country zipcode',
    ).lean()
    if (!companyInfo) return res.status(404).json({ msg: 'Company not found' })
    if (!companyInfo.plan) return res.status(404).json({ msg: 'Something went wrong' })
    if (companyInfo.plan === 'Business') return res.status(400).json({ msg: 'Something went wrong' })
    const allowed = {
      Starter: ['Team', 'Business'],
      Team: ['Business'],
    }
    if (!allowed[companyInfo.plan].includes(switchTo)) return res.status(400).json({ msg: 'Invalid plan switch request' })
    const planInfo = getPlanByNameAndDuration(switchTo, duration)
    if (!planInfo) return res.status(400).json({ msg: 'This plan is not active yet' })
    const planExpiry = dateAfterYear()
    const crypto = require('crypto')
    const receiptHash = crypto.randomBytes(4).toString('hex')
    console.log(`🔄 Creating Razorpay order for upgrade: ${companyInfo.plan} → ${switchTo}`)
    // Get complete customer details
    const customerDetails = await getCompleteCustomerDetails(id, companyInfo)

    // Ensure Razorpay customer is ready and stale addresses cleared
    try {
      await ensureRazorpayCustomerAddressesReady(id, companyInfo, customerDetails)
    } catch (syncErr) {
      console.warn('⚠️ ensureRazorpayCustomerAddressesReady in upgradeSubscription:', syncErr.message)
    }

    // Create Invoice instead of Order for upgrade
    const invoicePayload = {
      type: 'invoice',
      description: `Upgrade to ${switchTo} plan`,
      customer: {
        name: customerDetails.name,
        email: customerDetails.email,
        contact: customerDetails.contact,
        billing_address: customerDetails.billing_address,
        // shipping_address: customerDetails.shipping_address, // Commented: Only Bill To required
      },
      line_items: [
        {
          name: `${switchTo} yearly plan`,
          description:
            switchTo === 'Business'
              ? 'Business yearly subscription with essential premium features for growing organizations.'
              : switchTo === 'Team'
                ? 'Team yearly subscription with essential premium features for small businesses.'
                : switchTo === 'Starter'
                  ? 'Starter yearly subscription with essential features for individual professionals.'
                  : `Yearly subscription for ${switchTo} Plan with ${planInfo.seat} users.`,
          amount: planInfo.price * 100,
          currency: 'INR',
          quantity: 1,
        },
      ],
      email_notify: 1,
      sms_notify: 1,
      notes: {
        userId: id,
        planName: switchTo,
        isUpgrading: true,
        endAt: planExpiry,
        fname: companyInfo.fName,
        lname: companyInfo.lName,
        email: companyInfo.email,
        companyName: companyInfo.companyName,
        seat: planInfo.seat,
      },
      callback_url: `${process.env.FRONTEND_URI}/managelicense`,
      callback_method: 'get',
    }

    if (customerDetails.gstin) {
      invoicePayload.customer.gstin = customerDetails.gstin
    }

    const createRes = await razorpay.invoices.create(invoicePayload)

    console.log(`✅ Invoice created for upgrade: ${createRes.id}, order_id: ${createRes.order_id}`)
    res.status(200).json({
      status: true,
      data: {
        ...createRes,
        id: createRes.order_id || createRes.id,
        order_id: createRes.order_id,
        invoice_id: createRes.id,
        amount: createRes.amount,
        currency: createRes.currency,
      },
      notes: createRes.notes,
    })
  } catch (err) {
    console.error('❌ upgradeSubscription Error:', err)
    return res.status(500).json({ msg: 'Failed to create payment order. Please try again.' })
  }
}
const renewPlan = async (req, res) => {
  try {
    const { plan } = req.body
    const { id } = req.user
    await dbConnect()
    const company = await Company.findOne(
      { _id: id },
      'plan razorpayCustomerId fName lName email expiredAt seatPurchased seatCapacity companyName phone phoneCode address city state country zipcode',
    ).lean()
    if (!company) return res.status(404).json({ msg: 'Company not found' })
    if (!company.plan) return res.status(404).json({ msg: 'No plan found' })
    if (company.expiredAt > now()) return res.status(400).json({ msg: 'Your plan is not expired yet' })

    let planInfo = getPlanByNameAndDuration(plan, 'yearly')

    // ✅ CRITICAL: Handle Custom Plan (Enterprise) if not in plan.json yearly list
    let isCustomPlan = false
    let customPlanId = null

    if (!planInfo && plan === 'Enterprise') {
      console.log(`🔍 Fetching latest custom plan details for renewal, user: ${id}`)
      const lastCustomPlan = await CustomPlan.findOne({ userId: id }).sort({ createdAt: -1 }).lean()
      if (lastCustomPlan) {
        planInfo = {
          seat: lastCustomPlan.seat,
          price: lastCustomPlan.amount,
        }
        isCustomPlan = true
        customPlanId = lastCustomPlan._id.toString()
        console.log(`✅ Loaded custom plan for renewal: ${lastCustomPlan.seat} seats, ₹${lastCustomPlan.amount}`)
      }
    }

    if (!planInfo) {
      return res.status(400).json({ msg: 'Invalid plan or plan info not found for renewal' })
    }

    if (plan !== company.plan) {
      const currentUsedSeats = company.seatPurchased
      const applicableSeats = planInfo.seat
      if (currentUsedSeats > applicableSeats) {
        return res.status(400).json({ msg: 'action', data: { currentUsedSeats, applicableSeats } })
      }
    }
    const crypto = require('crypto')
    const receiptHash = crypto.randomBytes(4).toString('hex')
    console.log(`🔄 Creating Razorpay order for renewal: ${plan}`)
    // Get complete customer details
    const customerDetails = await getCompleteCustomerDetails(id, company)

    // Ensure Razorpay customer is ready and stale addresses cleared
    try {
      await ensureRazorpayCustomerAddressesReady(id, company, customerDetails)
    } catch (syncErr) {
      console.warn('⚠️ ensureRazorpayCustomerAddressesReady in renewPlan:', syncErr.message)
    }

    // Create Invoice instead of Order for renewal
    const invoicePayload = {
      type: 'invoice',
      description: `Renewal of ${plan} plan`,
      customer: {
        name: customerDetails.name,
        email: customerDetails.email,
        contact: customerDetails.contact,
        billing_address: customerDetails.billing_address,
        // shipping_address: customerDetails.shipping_address, // Commented: Only Bill To required
      },
      line_items: [
        {
          name: `${plan} yearly plan`,
          description:
            plan === 'Business'
              ? 'Business yearly subscription with essential premium features for growing organizations.'
              : plan === 'Team'
                ? 'Team yearly subscription with essential premium features for small businesses.'
                : plan === 'Starter'
                  ? 'Starter yearly subscription with essential features for individual professionals.'
                  : `Yearly subscription for ${plan} Plan with ${planInfo.seat} users.`,
          amount: Math.round(planInfo.price * 100), // Ensure it's an integer
          currency: 'INR',
          quantity: 1,
        },
      ],
      email_notify: 1,
      sms_notify: 1,
      notes: {
        userId: id,
        planName: plan,
        isRenewing: true,
        endAt: dateAfterYear(),
        fname: company.fName,
        lname: company.lName,
        email: company.email,
        companyName: company.companyName,
        seat: planInfo.seat,
        // ✅ Add custom plan flags if applicable
        isCustomPlan: isCustomPlan,
        customPlanId: customPlanId,
      },
      callback_url: `${process.env.FRONTEND_URI}/managelicense`,
      callback_method: 'get',
    }

    if (customerDetails.gstin) {
      invoicePayload.customer.gstin = customerDetails.gstin
    }

    const createRes = await razorpay.invoices.create(invoicePayload)

    console.log(`✅ Invoice created for renewal: ${createRes.id}, order_id: ${createRes.order_id}`)
    res.status(200).json({
      status: true,
      data: {
        ...createRes,
        id: createRes.order_id || createRes.id,
        order_id: createRes.order_id,
        invoice_id: createRes.id,
        amount: createRes.amount,
        currency: createRes.currency,
      },
      notes: createRes.notes,
    })
  } catch (err) {
    console.error('❌ renewPlan Error:', err)
    return res.status(500).json({ msg: 'Failed to create payment order. Please try again.' })
  }
}
const extendCurrentPlan = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()
    const company = await Company.findOne(
      { _id: id },
      'plan razorpayCustomerId fName lName email expiredAt seatPurchased seatCapacity companyName phone phoneCode address city state country zipcode',
    ).lean()
    if (!company) return res.status(404).json({ msg: 'Company not found' })
    if (!company.plan) return res.status(404).json({ msg: 'Unsubscribed user' })

    let planInfo = getPlanByNameAndDuration(company.plan, 'yearly')

    // ✅ CRITICAL: Handle Custom Plan (Enterprise) if not in plan.json yearly list
    let isCustomPlan = false
    let customPlanId = null

    if (!planInfo && company.plan === 'Enterprise') {
      console.log(`🔍 Fetching latest custom plan details for user: ${id}`)
      const lastCustomPlan = await CustomPlan.findOne({ userId: id }).sort({ createdAt: -1 }).lean()
      if (lastCustomPlan) {
        planInfo = {
          seat: lastCustomPlan.seat,
          price: lastCustomPlan.amount,
        }
        isCustomPlan = true
        customPlanId = lastCustomPlan._id.toString()
        console.log(`✅ Loaded custom plan: ${lastCustomPlan.seat} seats, ₹${lastCustomPlan.amount}`)
      }
    }

    if (!planInfo) {
      return res.status(400).json({ msg: 'Invalid plan or plan info not found for extension' })
    }

    // Get complete customer details
    const customerDetails = await getCompleteCustomerDetails(id, company)

    // Ensure Razorpay customer is ready and stale addresses cleared
    try {
      await ensureRazorpayCustomerAddressesReady(id, company, customerDetails)
    } catch (syncErr) {
      console.warn('⚠️ ensureRazorpayCustomerAddressesReady in extendCurrentPlan:', syncErr.message)
    }

    const customerObj = {
      name: customerDetails.name,
      email: customerDetails.email,
      contact: customerDetails.contact,
      billing_address: customerDetails.billing_address,
      // shipping_address: customerDetails.shipping_address, // Commented: Only Bill To required
    }
    if (customerDetails.gstin) {
      customerObj.gstin = customerDetails.gstin
    }

    // Create invoice with complete customer details
    const createRes = await razorpay.invoices.create({
      type: 'invoice',
      description: `Invoice for ${company.plan} plan extension`,
      customer: customerObj,
      line_items: [
        {
          name: `${company.plan} Plan Extension`,
          description: `Extension of ${company.plan} plan for 1 year with ${planInfo.seat} user licenses`,
          amount: Math.round(planInfo.price * 100), // Ensure it's an integer
          currency: 'INR',
          quantity: 1,
        },
      ],
      email_notify: 1,
      sms_notify: 1,
      partial_payment: false,
      notes: {
        userId: id,
        fname: company.fName,
        lname: company.lName,
        email: company.email,
        companyName: company.companyName,
        planName: company.plan,
        endAt: dateAfterYear(company.expiredAt),
        seat: planInfo.seat,
        isExtending: true,
        // ✅ Add custom plan flags if applicable
        isCustomPlan: isCustomPlan,
        customPlanId: customPlanId,
      },
      callback_url: `${process.env.FRONTEND_URI}/managelicense`,
      callback_method: 'get',
    })
    console.log(`✅ Invoice created for extension: ${createRes.id}, order_id: ${createRes.order_id}`)
    console.log('📋 Extension invoice customer details:', JSON.stringify(createRes.customer_details, null, 2))
    res.status(200).json({
      status: true,
      data: {
        ...createRes,
        id: createRes.order_id || createRes.id,
        order_id: createRes.order_id,
        invoice_id: createRes.id,
        amount: createRes.amount,
        currency: createRes.currency,
      },
    })
  } catch (error) {
    console.log('❌ extendCurrentPlan err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}
const upsertBillingAddress = async (req, res) => {
  try {
    const { id } = req.user
    const { line1, line2, city, state, country, zipcode, gstin } = req.body

    if (!(line1 && city && state && country && zipcode)) {
      return res.status(400).json({
        msg: 'Invalid address. Required: line1, city, state, country, zipcode',
      })
    }

    await dbConnect()

    // Get current GSTIN from company if not provided
    const company = await Company.findOne({ _id: id }, 'gstin').lean()
    const finalGstin = gstin || company?.gstin || null

    const billingData = {
      line1,
      line2: line2 || '',
      city,
      state,
      country,
      zipcode,
      gstin: finalGstin,
      updatedAt: now(),
    }

    const existed = await BillingInfo.findOne(
      {
        owner: id,
        isDeleted: false,
      },
      '_id',
    ).lean()

    if (existed) {
      await BillingInfo.updateOne({ _id: existed._id }, billingData)
      console.log('✅ Billing address updated with GSTIN:', finalGstin)
    } else {
      await BillingInfo.create({
        owner: id,
        ...billingData,
        createdAt: now(),
      })
      console.log('✅ Billing address created with GSTIN:', finalGstin)
    }

    // Also update company address
    // await Company.updateOne(
    //   { _id: id },
    //   {
    //     $set: {
    //       address: line1,
    //       city,
    //       state,
    //       country,
    //       zipcode,
    //       gstin: finalGstin,
    //       updatedAt: now(),
    //     },
    //   },
    // )
    // Do NOT overwrite Company address with billing address.
    // Keep billing address separate in `BillingInfo` collection so
    // company physical address (used across UI) remains independent.
    console.log('ℹ️ Billing address saved separately (Company record not modified)')

    res.status(200).json({
      status: true,
      msg: `Address ${existed ? 'updated' : 'added'} successfully`,
      data: { gstin: finalGstin },
    })
  } catch (error) {
    console.log('❌ upsertBillingAddress err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const updateTaxDetails = async (req, res) => {
  try {
    const { id } = req.user
    const { gstin } = req.body
    if (!gstin) {
      return res.status(400).json({ msg: 'Tax code is required' })
    }
    await dbConnect()

    // Update company model
    await Company.updateOne({ _id: id }, { $set: { gstin, updatedAt: now() } })

    // Update billing info if exists
    await BillingInfo.updateMany({ owner: id, isDeleted: false }, { $set: { gstin } })

    res.status(200).json({ status: true, msg: 'Tax details updated successfully' })
  } catch (error) {
    console.log('❌ updateTaxDetails err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const deleteTaxDetails = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()

    // Update company model
    await Company.updateOne({ _id: id }, { $set: { gstin: null, updatedAt: now() } })

    // Update billing info if exists
    await BillingInfo.updateMany({ owner: id, isDeleted: false }, { $set: { gstin: null } })

    res.status(200).json({ status: true, msg: 'Tax details deleted successfully' })
  } catch (error) {
    console.log('❌ deleteTaxDetails err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}
const getBillingAddress = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()
    const billingInfo = await BillingInfo.findOne({ owner: id, isDeleted: false }, 'line1 line2 city state country zipcode gstin').lean()

    if (!billingInfo) {
      // Fallback: check company for gstin even if no billing record exists
      const company = await Company.findOne({ _id: id }, 'gstin').lean()
      if (company && company.gstin) {
        return res.status(200).json({ status: true, data: { gstin: company.gstin } })
      }
      return res.status(404).json({ msg: 'Not found' })
    }

    res.status(200).json({ status: true, data: billingInfo })
  } catch (error) {
    console.log('❌ getBillingAddress err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}
const removeBillingAddress = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()
    const billingInfo = await BillingInfo.findOne({ owner: id, isDeleted: false }, '_id').lean()
    if (!billingInfo) return res.status(404).json({ msg: 'Not found' })
    await BillingInfo.updateOne({ _id: billingInfo._id }, { isDeleted: true })
    res.status(200).json({ status: true, msg: 'Billing address removed successfully' })
  } catch (error) {
    console.log('❌ removeBillingAddress err', error)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}
const getAssignedPlanInfo = async (req, res) => {
  try {
    const { user, plan } = req.body
    if (!user || !plan) {
      return res.status(404).json({ msg: 'Invalid Request' })
    }
    const companyId = dec(user, process.env.ID_SECRET)
    const planId = dec(plan, process.env.ID_SECRET)
    await dbConnect()
    const companyInfo = await Company.findOne({ _id: companyId }, 'email plan seatCapacity seatPurchased expiredAt').lean()
    if (!companyInfo) return res.status(404).json({ msg: 'Invalid Request' })
    const assignedPlan = await CustomPlan.findOne({ _id: planId, userId: companyId }, { createdAt: 0, userId: 0 }).lean()
    if (!assignedPlan) return res.status(404).json({ status: false, msg: 'You have not been assigned a custom plan yet' })

    // Check if an authorization token is provided and validate matching email
    const token = (req.headers['authorization'] || '').trim()
    let loggedInCompany = null
    let isEmailMismatch = false

    if (token) {
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET)
        if (decoded && decoded.user && decoded.user.id) {
          loggedInCompany = await Company.findById(decoded.user.id, 'email').lean()
          if (loggedInCompany && loggedInCompany.email.toLowerCase() !== companyInfo.email.toLowerCase()) {
            isEmailMismatch = true
          }
        }
      } catch (tokenErr) {
        console.warn('⚠️ Token verification failed in getAssignedPlanInfo:', tokenErr.message)
      }
    }

    if (isEmailMismatch) {
      return res.status(200).json({
        status: false,
        isEmailMismatch: true,
        assignedEmail: companyInfo.email,
        loggedInEmail: loggedInCompany ? loggedInCompany.email : null,
        msg: `This custom plan is assigned to ${companyInfo.email}. But you're currently logged in as ${loggedInCompany?.email || 'a different account'}.`,
      })
    }

    if (Number(assignedPlan.status) === 5 || assignedPlan.isRefunded || assignedPlan.refundStatus === 'refunded') {
      return res.status(200).json({
        status: false,
        isRefunded: true,
        assignedEmail: companyInfo.email,
        msg: 'This custom plan has been refunded. You cannot purchase this plan.',
      })
    }
    if (Number(assignedPlan.status) === 1 || assignedPlan.isActive) {
      return res.status(200).json({
        status: false,
        isAlreadyPaid: true,
        assignedEmail: companyInfo.email,
        msg: 'This custom plan has already been purchased and activated. You cannot pay again.',
      })
    }
    if (Number(assignedPlan.invoiceExpiry) < now()) {
      return res
        .status(200)
        .json({
          status: false,
          assignedEmail: companyInfo.email,
          msg: `Custom plan is expired on ${dateConverter(assignedPlan.invoiceExpiry)}. Please make request again.`,
        })
    }

    // ✅ Include decrypted IDs and assignedEmail for frontend
    res.status(200).json({
      status: true,
      data: {
        ...assignedPlan,
        assignedEmail: companyInfo.email,
        decryptedUserId: companyId,
        decryptedPlanId: planId,
      },
    })
  } catch (err) {
    console.log('❌ getAssignedPlanInfo err', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}
const buyCustomPlan = async (req, res) => {
  try {
    let { userId, planId, notes } = req.body

    console.log('🛒 buyCustomPlan called with:', { userId, planId, notes })

    // Verify token for email-based access validation
    const token = (req.headers['authorization'] || '').trim()
    if (!token) {
      return res.status(401).json({ status: false, msg: 'Authentication required. Please log in to complete custom plan purchase.' })
    }

    let tokenUserId
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET)
      tokenUserId = decoded?.user?.id
    } catch (tokenErr) {
      return res.status(401).json({ status: false, msg: 'Invalid or expired session. Please log in again.' })
    }

    if (!tokenUserId) {
      return res.status(401).json({ status: false, msg: 'Invalid authentication session.' })
    }

    await dbConnect()

    // 1. Fetch Plan details first to get userId if needed
    const planInfo = await CustomPlan.findById(planId).lean()
    if (!planInfo) {
      return res.status(404).json({ msg: 'Selected plan details not found' })
    }

    // 2. Enforce that authenticated user matches plan assigned user
    if (tokenUserId.toString() !== planInfo.userId.toString()) {
      const assignedCompany = await Company.findById(planInfo.userId, 'email').lean()
      const assignedEmail = assignedCompany ? assignedCompany.email : 'the assigned account'
      return res.status(403).json({
        status: false,
        msg: `Access denied: Only the assigned email (${assignedEmail}) can purchase this custom plan.`,
      })
    }

    // 3. If userId not provided, extract from planInfo
    if (!userId) {
      userId = planInfo.userId
      console.log('📝 userId extracted from plan:', userId)
    }

    // 4. Fetch User/Company details - Fetch plan info to detect upgrade
    const companyInfo = await Company.findOne(
      { _id: userId },
      'fName lName email companyName phone phoneCode address city state country zipcode plan expiredAt',
    ).lean()

    if (!companyInfo) {
      return res.status(404).json({ msg: 'Company profile not found' })
    }

    // 4. Validate plan is not refunded, still pending (status 0), and not expired
    if (Number(planInfo.status) === 5 || planInfo.isRefunded || planInfo.refundStatus === 'refunded') {
      return res.status(400).json({ status: false, msg: 'This custom plan has been refunded. You cannot purchase this plan.' })
    }

    if (Number(planInfo.status) !== 0 || planInfo.isActive) {
      return res.status(400).json({ status: false, msg: 'This custom plan has already been purchased and activated.' })
    }

    if (Number(planInfo.invoiceExpiry) < now()) {
      return res.status(400).json({ msg: 'This custom plan invitation has expired. Please request a new one.' })
    }

    // 5. Get complete customer details including billing address
    const customerDetails = await getCompleteCustomerDetails(userId, companyInfo)
    if (!customerDetails) {
      return res.status(500).json({ msg: 'Failed to fetch customer details' })
    }

    // Ensure Razorpay customer is ready and stale addresses cleared
    try {
      await ensureRazorpayCustomerAddressesReady(userId, companyInfo, customerDetails)
    } catch (syncErr) {
      console.warn('⚠️ ensureRazorpayCustomerAddressesReady in buyCustomPlan:', syncErr.message)
    }

    // 6. Construct the Razorpay Invoice Object
    // All customer fields here will appear on the generated PDF
    const planName = 'Enterprise' // Use 'Enterprise' marker for system recognition

    const invoicePayload = {
      type: 'invoice',
      description: `Upgrade to ${planName}`,
      customer: {
        name: customerDetails.name,
        email: customerDetails.email,
        contact: customerDetails.contact,
        billing_address: customerDetails.billing_address,
        // shipping_address: customerDetails.shipping_address, // Commented: Only Bill To required
      },
      line_items: [
        {
          name: planName,
          description: `Subscription for ${planInfo.seat} seats`,
          amount: Math.round(planInfo.amount * 100), // Convert to Paise
          currency: 'INR',
          quantity: 1,
        },
      ],
      email_notify: 1,
      sms_notify: 1,
      currency: 'INR',
      expire_by: Number(planInfo.invoiceExpiry), // Use plan's invoice expiry (already in seconds)
      notes: {
        userId: userId.toString(),
        planId: planId.toString(),
        planName: planName,
        fname: companyInfo.fName,
        lname: companyInfo.lName,
        email: companyInfo.email,
        companyName: companyInfo.companyName,
        internalNotes: notes || 'Custom plan purchase',
        // ✅ CRITICAL: Add these fields for verifyPayment to work correctly
        customPlanId: planId.toString(),
        seat: planInfo.seat,
        isCustomPlan: true, // Use boolean directly
        isUpgrading: !!companyInfo.plan, // Detect if this is an upgrade to trigger auto-refund
        endAt: planInfo.planExpiry,
        isPurchasing: !companyInfo.plan,
      },
      callback_url: `${process.env.FRONTEND_URI}/managelicense`,
      callback_method: 'get',
    }

    if (customerDetails.gstin) {
      invoicePayload.customer.gstin = customerDetails.gstin
    }

    console.log('📋 Invoice Payload:', JSON.stringify(invoicePayload, null, 2))

    // 7. Create Invoice through Razorpay
    const createRes = await razorpay.invoices.create(invoicePayload)

    console.log('✅ Invoice Created Successfully. ID:', createRes.id)
    console.log('👤 Customer Details sent to Invoice:', JSON.stringify(createRes.customer_details, null, 2))

    return res.status(200).json({
      status: true,
      message: 'Invoice generated with full customer details',
      data: {
        ...createRes,
        id: createRes.order_id || createRes.id,
        order_id: createRes.order_id,
        invoice_id: createRes.id,
        amount: createRes.amount,
        currency: createRes.currency,
      },
    })
  } catch (err) {
    console.error('❌ buyCustomPlan Error:', err)
    // Extract Razorpay error description if available
    const errorDescription = err.error ? err.error.description : err.message
    return res.status(500).json({
      status: false,
      msg: 'Failed to generate invoice. Ensure your Razorpay keys and customer data are correct.',
      error: errorDescription,
    })
  }
}
const syncRefunds = async (req, res) => {
  try {
    const { id } = req.user
    const { syncUserRefunds } = require('../../utils/trade/paymentHandler')
    const totalSynced = await syncUserRefunds(id)
    return res.status(200).json({
      status: true,
      msg: `Synced ${totalSynced} refunds`,
      data: { totalSynced },
    })
  } catch (error) {
    console.error('❌ syncRefunds error:', error.message)
    return res.status(500).json({
      status: false,
      msg: 'Failed to sync refunds',
    })
  }
}
const getRefundHistory = async (req, res) => {
  try {
    const { id } = req.user
    const { page = 1, limit = 10, paymentId } = req.query
    const skip = (page - 1) * limit
    await dbConnect()
    let query = { userId: id }
    if (paymentId) {
      query.paymentId = paymentId
    }
    // Get refund transactions (type 3, 4, 6)
    const refunds = await Transaction.find({
      ...query,
      type: { $in: [3, 4, 6] }, // Refund Created, Refund Processed, Partial Refund
    })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean()
    // Get total count
    const total = await Transaction.countDocuments({
      ...query,
      type: { $in: [3, 4, 6] },
    })
    // Enrich with payment details
    const enrichedRefunds = await Promise.all(
      refunds.map(async (refund) => {
        // Get original payment details
        const originalPayment = await Transaction.findOne({
          paymentId: refund.paymentId,
          userId: id,
          type: { $in: [1, 2, 5] }, // Purchase, Upgrade, Renewal
        }).lean()
        // Get company info for billing details
        const companyInfo = await Company.findOne({ _id: id }, 'fName lName email companyName phone phoneCode').lean()
        return {
          ...refund,
          originalPlan: originalPayment?.plan || 'Unknown',
          originalAmount: originalPayment?.amount || 0,
          customerName: companyInfo ? `${companyInfo.fName} ${companyInfo.lName}` : '',
          customerEmail: companyInfo?.email || '',
          companyName: companyInfo?.companyName || '',
          isFullRefund: Math.abs(refund.amount) === Math.abs(originalPayment?.amount || 0),
        }
      }),
    )
    return res.status(200).json({
      status: true,
      data: {
        refunds: enrichedRefunds,
        total,
        page: parseInt(page),
        totalPages: Math.ceil(total / limit),
      },
    })
  } catch (error) {
    console.error('❌ getRefundHistory error:', error.message)
    return res.status(500).json({
      status: false,
      msg: 'Failed to fetch refund history',
    })
  }
}
const getTransactionWithRefunds = async (req, res) => {
  try {
    const { id } = req.user
    const { paymentId } = req.body
    if (!paymentId) {
      return res.status(400).json({
        status: false,
        msg: 'Payment ID is required',
      })
    }
    const { getRefundDetails } = require('../../utils/trade/paymentHandler')
    const refundData = await getRefundDetails(paymentId, id)
    // Get company info
    const companyInfo = await Company.findOne(
      { _id: id },
      'fName lName email companyName phone phoneCode plan expiredAt seatCapacity seatPurchased',
    ).lean()
    return res.status(200).json({
      status: true,
      data: {
        ...refundData,
        companyInfo: {
          name: companyInfo ? `${companyInfo.fName} ${companyInfo.lName}` : '',
          email: companyInfo?.email || '',
          companyName: companyInfo?.companyName || '',
          currentPlan: companyInfo?.plan || 'No active plan',
          planExpiry: companyInfo?.expiredAt ? new Date(companyInfo.expiredAt * 1000) : null,
          seats: {
            purchased: companyInfo?.seatPurchased || 0,
            capacity: companyInfo?.seatCapacity || 0,
            total: (companyInfo?.seatPurchased || 0) + (companyInfo?.seatCapacity || 0),
          },
        },
      },
    })
  } catch (error) {
    console.error('❌ getTransactionWithRefunds error:', error.message)
    return res.status(500).json({
      status: false,
      msg: 'Failed to fetch transaction details',
    })
  }
}
const initiateRefund = async (req, res) => {
  try {
    const { id } = req.user
    const { paymentId, amount, reason } = req.body
    if (!paymentId || !amount) {
      return res.status(400).json({
        status: false,
        msg: 'Payment ID and amount are required',
      })
    }
    await dbConnect()
    // Get original transaction
    const originalTransaction = await Transaction.findOne({
      paymentId: paymentId,
      userId: id,
      type: { $in: [1, 2, 5] },
    })
    if (!originalTransaction) {
      return res.status(404).json({
        status: false,
        msg: 'Transaction not found',
      })
    }
    // Check if refund is possible
    const alreadyRefunded = originalTransaction.refundAmount || 0
    const maxRefundable = originalTransaction.amount - alreadyRefunded
    if (amount > maxRefundable) {
      return res.status(400).json({
        status: false,
        msg: `Maximum refundable amount is ${maxRefundable}`,
      })
    }
    // Create refund in Razorpay
    const { createRazorpayRefund } = require('../../utils/trade/paymentHandler')
    const razorpayRefund = await createRazorpayRefund(paymentId, amount, {
      reason: reason || 'Customer request',
      initiatedBy: 'user',
      userId: id.toString(),
      originalAmount: originalTransaction.amount,
      originalPlan: originalTransaction.plan,
    })
    // Create refund record immediately
    const refundDoc = new Refund({
      userId: id,
      paymentId: paymentId,
      refundId: `ref_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      razorpayRefundId: razorpayRefund.id,
      amount: amount,
      originalAmount: originalTransaction.amount,
      currency: originalTransaction.currency,
      status: 'initiated',
      refundedBy: 'user',
      reason: reason || 'Customer request',
      notes: JSON.stringify({ initiatedBy: 'user', reason: reason }),
      speedRequested: 'optimum',
      razorpayDetails: razorpayRefund,
      createdAt: now(),
    })
    await refundDoc.save()
    // Update original transaction
    await Transaction.findOneAndUpdate(
      { _id: originalTransaction._id },
      {
        $set: {
          refundAmount: (originalTransaction.refundAmount || 0) + amount,
          netAmount: originalTransaction.amount - ((originalTransaction.refundAmount || 0) + amount),
          refundStatus: 'initiated',
          status: amount === originalTransaction.amount ? 'refunded' : 'partially_refunded',
          type: amount === originalTransaction.amount ? 3 : 6,
          razorpayRefundId: razorpayRefund.id,
          updatedAt: now(),
        },
      },
    )
    // Create refund transaction record
    await recordRefundTransaction(id, {
      invoiceId: originalTransaction.invoiceId,
      paymentId: paymentId,
      orderId: originalTransaction.orderId,
      plan: originalTransaction.plan,
      amount: 0 - amount,
      refundAmount: amount,
      netAmount: 0 - amount,
      type: 3, // Refund Created
      refundId: refundDoc.refundId,
      razorpayRefundId: razorpayRefund.id,
      currency: originalTransaction.currency,
      refundNotes: reason || 'Customer request',
      createdAt: now(),
    })
    createLog(id, 'Refund initiated', `${razorpayRefund.id} - ${amount} ${originalTransaction.currency}`)
    return res.status(200).json({
      status: true,
      msg: 'Refund initiated successfully',
      data: {
        refundId: razorpayRefund.id,
        amount: amount,
        status: 'initiated',
        estimatedCompletion: '3-7 business days',
      },
    })
  } catch (error) {
    console.error('❌ initiateRefund error:', error.message)
    // Check if it's a Razorpay error
    if (error.error && error.error.description) {
      return res.status(400).json({
        status: false,
        msg: error.error.description,
      })
    }
    return res.status(500).json({
      status: false,
      msg: 'Failed to initiate refund',
    })
  }
}
module.exports = {
  purchasePlan,
  paymentWebhook,
  getInvoices,
  getCurrentPlanInfo,
  upgradeSubscription,
  getInvoiceUrl,
  renewPlan,
  extendCurrentPlan,
  upsertBillingAddress,
  getBillingAddress,
  removeBillingAddress,
  getAssignedPlanInfo,
  buyCustomPlan,
  verifyPayment,
  getCompleteCustomerDetails,
  syncRefunds,
  getRefundHistory,
  getTransactionWithRefunds,
  initiateRefund,
  updateTaxDetails,
  deleteTaxDetails,
}

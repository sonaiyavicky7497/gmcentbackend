const Razorpay = require('razorpay')
const axios = require('axios')

// Validate environment variables
if (!process.env.RAZORPAY_KEY || !process.env.RAZORPAY_SECRET) {
  console.error('❌ CRITICAL: Razorpay credentials missing! Set RAZORPAY_KEY and RAZORPAY_SECRET in .env')
}

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY,
  key_secret: process.env.RAZORPAY_SECRET,
})

/**
 * Find existing Razorpay customer by email
 * @param {string} email - Customer email
 * @returns {object|null} Customer object or null
 */
const findRazorpayCustomerByEmail = async (email) => {
  const cleanEmail = email?.trim().toLowerCase()
  if (!cleanEmail) return null

  try {
    let skip = 0
    const count = 100 // Max allowed by Razorpay

    // Paginate through all customers to find by email
    while (true) {
      const response = await razorpay.customers.all({ count, skip })

      if (!response || !response.items || response.items.length === 0) {
        break
      }

      // Find customer with matching email
      const found = response.items.find((c) => c.email?.toLowerCase() === cleanEmail)

      if (found) {
        console.log(`✅ Found existing Razorpay customer: ${found.id} for email: ${cleanEmail}`)
        return found
      }

      // If we got fewer items than requested, we've reached the end
      if (response.items.length < count) {
        break
      }

      skip += count

      // Safety limit to prevent infinite loops
      if (skip > 10000) {
        console.warn('⚠️ Reached safety limit while searching for customer')
        break
      }
    }

    console.log(`ℹ️ No existing Razorpay customer found for email: ${cleanEmail}`)
    return null
  } catch (err) {
    console.error(`❌ Error searching Razorpay customer:`, err.message)
    return null
  }
}

/**
 * Create or update Razorpay customer
 * @param {string} name - Customer name
 * @param {string} email - Customer email (required)
 * @param {string} contact - Phone number (optional)
 * @param {string} gst - GSTIN (optional)
 * @param {string} shipping_address - Shipping address (optional)
 * @param {string} customerId - Existing Razorpay customer ID for updates (optional)
 * @returns {object|null} Customer object or null
 */
const upsertRazorpayCustomer = async (name, email, contact = '', gst = '', shipping_address = '', customerId = null) => {
  const cleanEmail = email?.trim().toLowerCase()
  const cleanContact = contact?.trim() || undefined
  const cleanName = name?.trim() || 'Customer'

  // Email is required for customer creation
  if (!cleanEmail) {
    console.error('❌ Email is required for Razorpay customer creation')
    return null
  }

  try {
    // CASE 1: Update existing customer by ID
    if (customerId) {
      console.log(`🔄 Updating Razorpay customer: ${customerId}`)
      const updateData = {
        name: cleanName,
        // ...(shipping_address && { shipping_address }), // Commented: Only Bill To address required on invoices
        ...(gst && { gstin: gst }),
        ...(cleanContact && { contact: cleanContact }),
      }

      const customer = await razorpay.customers.edit(customerId, updateData)
      console.log('✅ Razorpay customer updated:', customer.id)
      return customer
    }

    // CASE 2: Check if customer already exists with this email
    console.log(`🔍 Checking for existing Razorpay customer: ${cleanEmail}`)
    const existingCustomer = await findRazorpayCustomerByEmail(cleanEmail)

    if (existingCustomer) {
      console.log(`✅ Using existing Razorpay customer: ${existingCustomer.id}`)
      return existingCustomer
    }

    // CASE 3: Create new customer
    console.log(`➕ Creating new Razorpay customer for: ${cleanEmail}`)

    const customerData = {
      name: cleanName,
      email: cleanEmail,
      ...(cleanContact && { contact: cleanContact }),
      fail_existing: 0, // Return existing customer if email matches (Razorpay v1)
      notes: {
        generatedBy: 'gps-map-camera-ent',
        createdAt: new Date().toISOString(),
      },
    }

    const customer = await razorpay.customers.create(customerData)
    console.log('✅ Razorpay customer created:', customer.id, 'for email:', cleanEmail)
    return customer
  } catch (err) {
    const errorDescription = err.error?.description || err.message || 'Unknown error'
    console.error(`❌ Razorpay upsertRazorpayCustomer Error for ${cleanEmail}:`, errorDescription)

    // If creation failed due to "customer already exists", try to find them
    if (errorDescription.toLowerCase().includes('already exists') || errorDescription.toLowerCase().includes('duplicate')) {
      console.log(`🔄 Customer may already exist, searching for: ${cleanEmail}`)

      try {
        const existingCustomer = await findRazorpayCustomerByEmail(cleanEmail)
        if (existingCustomer) {
          return existingCustomer
        }
      } catch (searchErr) {
        console.error('❌ Failed to search for existing customer:', searchErr.message)
      }
    }

    return null
  }
}

/**
 * Get Razorpay customer by ID
 * @param {string} customerId - Razorpay customer ID
 * @returns {object|null} Customer object or null
 */
const getRazorpayCustomer = async (customerId) => {
  if (!customerId) return null

  try {
    const customer = await razorpay.customers.fetch(customerId)
    return customer
  } catch (err) {
    console.error(`❌ getRazorpayCustomer Error:`, err.message)
    return null
  }
}

/**
 * Create a Razorpay order for payment
 * @param {number} amount - Amount in INR paise (e.g., 50000 for ₹500)
 * @param {string} customerId - Razorpay customer ID
 * @param {object} notes - Additional notes/metadata
 * @returns {object|null} Order object or null
 */
const createRazorpayOrder = async (amount, customerId, notes = {}) => {
  try {
    if (!amount || amount <= 0) {
      throw new Error('Invalid amount provided')
    }

    console.log(`🛒 Creating Razorpay order for amount: ₹${amount / 100}`)

    const orderData = {
      amount: amount, // in paise
      currency: 'INR',
      receipt: `receipt_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      notes: {
        createdAt: new Date().toISOString(),
        ...notes,
      },
    }

    // Only add customer_id if it exists
    if (customerId) {
      orderData.customer_id = customerId
    }

    const order = await razorpay.orders.create(orderData)
    console.log('✅ Razorpay order created:', order.id)
    return order
  } catch (err) {
    console.error(`❌ createRazorpayOrder Error:`, err.message)
    return null
  }
}

/**
 * Fetch a Razorpay order by ID
 * @param {string} orderId - Razorpay order ID
 * @returns {object|null} Order object or null
 */
const fetchRazorpayOrder = async (orderId) => {
  try {
    const order = await razorpay.orders.fetch(orderId)
    return order
  } catch (err) {
    console.error(`❌ fetchRazorpayOrder Error:`, err.message)
    return null
  }
}

/**
 * Capture a payment (when authorized)
 * @param {string} paymentId - Razorpay payment ID
 * @param {number} amount - Amount in paise
 * @returns {object|null} Payment object or null
 */
const capturePayment = async (paymentId, amount) => {
  try {
    const payment = await razorpay.payments.capture(paymentId, amount)
    console.log('✅ Payment captured:', paymentId)
    return payment
  } catch (err) {
    console.error(`❌ capturePayment Error:`, err.message)
    return null
  }
}

/**
 * Fetch payment details
 * @param {string} paymentId - Razorpay payment ID
 * @returns {object|null} Payment object or null
 */
const fetchPayment = async (paymentId) => {
  try {
    const payment = await razorpay.payments.fetch(paymentId)
    return payment
  } catch (err) {
    console.error(`❌ fetchPayment Error:`, err.message)
    return null
  }
}

/**
 * Clean stale customer addresses in Razorpay to ensure new invoice addresses can attach
 * @param {string} customerId - Razorpay customer ID (cust_...)
 */
const cleanCustomerAddresses = async (customerId) => {
  if (!customerId || typeof customerId !== 'string' || !customerId.startsWith('cust_')) return
  try {
    const auth = {
      username: process.env.RAZORPAY_KEY.trim(),
      password: process.env.RAZORPAY_SECRET.trim(),
    }
    const res = await axios.get(`https://api.razorpay.com/v1/customers/${customerId}/addresses`, { auth })
    if (res.data && Array.isArray(res.data.items) && res.data.items.length > 0) {
      console.log(`🧹 Cleaning ${res.data.items.length} stale addresses for Razorpay customer ${customerId}`)
      for (const item of res.data.items) {
        try {
          await axios.delete(`https://api.razorpay.com/v1/customers/${customerId}/addresses/${item.id}`, { auth })
        } catch (delErr) {
          console.warn(`⚠️ Failed to delete address ${item.id}:`, delErr.message)
        }
      }
    }
  } catch (err) {
    console.warn(`⚠️ Could not check/clean addresses for customer ${customerId}:`, err.message)
  }
}

module.exports = {
  razorpay,
  findRazorpayCustomerByEmail,
  upsertRazorpayCustomer,
  getRazorpayCustomer,
  createRazorpayOrder,
  fetchRazorpayOrder,
  capturePayment,
  fetchPayment,
  cleanCustomerAddresses,
}

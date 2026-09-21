const dbConnect = require('../../utils/dbConnect')
const Company = require('../../models/Company.model')
const jwt = require('jsonwebtoken')
const {
  dec,
  enc,
  imageURL,
  isValidPassword,
  generateId,
  queueMail,
  isValidMobile,
  isValidEmail,
  isTempEmail,
  dateConverter,
  getClientDetails,
  now,
} = require('../../utils/utilities')
const AdminConfig = require('../../models/AdminConfig.model')
const User = require('../../models/User.model')
const createLog = require('../../models/Logs.model')
const { upsertRazorpayCustomer } = require('../../utils/razorpay')
const UserFeedback = require('../../models/UserFeedback.model')
const PendingSignup = require('../../models/PendingSignup.model')

const signUp = async (req, res) => {
  console.log('='.repeat(50))
  console.log('🚀 SIGNUP API CALLED!')
  console.log('Time:', new Date().toISOString())
  console.log('Body:', { ...req.body, password: '***' })
  console.log('='.repeat(50))

  try {
    const { fName, lName, email, password } = req.body

    // Basic validation
    if (!fName || !fName.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'First name is required',
      })
    }
    if (!lName || !lName.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Last name is required',
      })
    }
    if (!email || !email.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Email is required',
      })
    }
    if (!password) {
      return res.status(400).json({
        status: false,
        msg: 'Password is required',
      })
    }

    // Email validation
    if (!isValidEmail(email)) {
      return res.status(400).json({
        status: false,
        msg: 'Please enter a valid email address',
      })
    }

    if (isTempEmail(email)) {
      return res.status(400).json({
        status: false,
        msg: 'Temporary email addresses are not allowed. Please use a permanent email.',
      })
    }

    // Password validation
    const passwordValidation = isValidPassword(password)
    if (passwordValidation !== true) {
      return res.status(400).json({
        status: false,
        msg: passwordValidation,
      })
    }

    console.log('🔗 Connecting to database...')
    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    // Check if email already exists in Company collection
    const existingCompany = await Company.findOne({ email: cleanEmail }, '_id').lean()
    if (existingCompany) {
      return res.status(400).json({
        status: false,
        msg: 'Email already registered. Please try logging in.',
      })
    }

    // Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000)
    const otpExpiry = now() + 300 // 5 minutes

    console.log('='.repeat(50))
    console.log(`🎉 OTP GENERATED FOR ${cleanEmail}: ${otp}`)
    console.log('='.repeat(50))

    // Create or update pending signup
    // NOTE: We do NOT create Razorpay customer here - only during verifyOTP
    const encryptedPassword = enc(password, process.env.PASSWORD_SECRET)
    const pendingData = {
      fName: fName.trim(),
      lName: lName.trim(),
      companyName: (req.body.cname || '').trim(),
      email: cleanEmail,
      password: encryptedPassword,
      otp: otp.toString(),
      otpExpiry,
      createdAt: now(),
    }

    const existingPending = await PendingSignup.findOne({ email: cleanEmail }).lean()
    if (existingPending) {
      await PendingSignup.updateOne({ email: cleanEmail }, { $set: pendingData })
      console.log(`🔁 Pending signup updated for: ${cleanEmail}`)
    } else {
      await PendingSignup.create(pendingData)
      console.log(`✅ Pending signup created for: ${cleanEmail}`)
    }

    // Send OTP email
    console.log('📧 Sending OTP email...')
    let emailSent = false
    let emailError = null

    try {
      await queueMail(cleanEmail, 'Email Verification OTP - GPS Map Camera ENT', 'otp', {
        otp: otp.toString(),
        name: fName.trim(),
        expiry: '5 minutes',
      })
      emailSent = true
      console.log(`✅ OTP email sent successfully to ${cleanEmail}`)
    } catch (err) {
      emailError = err
      console.error('❌ Error sending OTP email:', err.message)
    }

    if (!emailSent) {
      console.error('⚠️ WARNING: OTP email could not be sent')
      return res.status(200).json({
        status: true,
        msg: 'Registration initiated! However, OTP email could not be sent. Please use "Resend OTP" option.',
        email: cleanEmail,
        emailSent: false,
        warning: 'Email delivery failed. Please try resending OTP.',
      })
    }

    res.status(200).json({
      status: true,
      msg: 'Registration successful! Please check your email for OTP verification code.',
      email: cleanEmail,
      emailSent: true,
    })
  } catch (err) {
    console.error('❌ signUp error:', err)
    console.error('Stack:', err.stack)

    if (err.code === 11000) {
      return res.status(400).json({
        status: false,
        msg: 'Email already registered.',
      })
    }

    res.status(500).json({
      status: false,
      msg: 'Server error. Please try again.',
    })
  }
}

const login = async (req, res) => {
  try {
    const { email, password, customPlanUser } = req.body

    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!password) return res.status(400).json({ msg: 'Password is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    // If logging in via a Custom Plan purchase link, enforce email match
    if (customPlanUser) {
      try {
        const assignedCompanyId = dec(customPlanUser, process.env.ID_SECRET)
        const assignedCompany = await Company.findById(assignedCompanyId, 'email').lean()
        if (assignedCompany && assignedCompany.email) {
          if (cleanEmail !== assignedCompany.email.trim().toLowerCase()) {
            console.log(`⛔ Custom plan login rejected: attempt by ${cleanEmail} for plan assigned to ${assignedCompany.email}`)
            return res.status(403).json({
              status: false,
              msg: `Access restricted: Only ${assignedCompany.email} is authorized to access and purchase this custom plan.`,
            })
          }
        }
      } catch (decErr) {
        console.warn('⚠️ customPlanUser decryption error in login:', decErr.message)
      }
    }

    const company = await Company.findOne(
      { email: cleanEmail },
      '_id fName password isEmailVerified plan expiredAt totalSeat usedSeat remainingSeat seatCapacity seatPurchased companyName logo razorpayCustomerId',
    ).lean()

    if (!company) return res.status(400).json({ msg: 'You are not registered yet' })
    if (!company.password) return res.status(400).json({ msg: 'Invalid login method, Try google login' })

    if (dec(company.password, process.env.PASSWORD_SECRET) !== password) {
      return res.status(400).json({ msg: 'Wrong email or password' })
    }

    if (!company.isEmailVerified) {
      const newOtp = Math.floor(100000 + Math.random() * 900000)
      await queueMail(cleanEmail, 'Email Verification OTP', 'otp', { otp: newOtp, name: company.fName })
      await Company.updateOne({ email: cleanEmail }, { otp: newOtp, otpExpiry: now() + 300 })
      return res.status(400).json({ msg: 'unverified' })
    }

    // Create Razorpay customer if missing
    if (!company.razorpayCustomerId) {
      setImmediate(async () => {
        try {
          const razorpayCustomer = await upsertRazorpayCustomer(company.fName || 'User', cleanEmail)
          if (razorpayCustomer && razorpayCustomer.id) {
            await Company.updateOne({ _id: company._id }, { razorpayCustomerId: razorpayCustomer.id })
            console.log(`✅ Created missing Razorpay ID for existing user: ${razorpayCustomer.id}`)
          }
        } catch (err) {
          console.error('Failed to create Razorpay customer during login:', err.message)
        }
      })
    }

    const user = { id: company._id }
    const accessToken = jwt.sign({ user }, process.env.JWT_SECRET, { expiresIn: '30d' })

    const now_ts = Math.round(Date.now() / 1000)
    const isPlanActive = company.plan && company.expiredAt && company.expiredAt > now_ts

    const totalSeat = company.totalSeat !== undefined ? company.totalSeat : (company.seatCapacity || 0) + (company.seatPurchased || 0)
    const usedSeat = company.usedSeat !== undefined ? company.usedSeat : company.seatPurchased || 0
    const remainingSeat = company.remainingSeat !== undefined ? company.remainingSeat : company.seatCapacity || 0

    res.status(200).json({
      status: true,
      msg: 'Login successfully',
      data: {
        accessToken,
        plan: company.plan || null,
        totalSeat: totalSeat,
        usedSeat: usedSeat,
        remainingSeat: remainingSeat,
        seatCapacity: remainingSeat,
        seatPurchased: usedSeat,
        isPlanActive: isPlanActive,
        expiredAt: company.expiredAt || null,
        companyName: company.companyName || null,
        logo: company.logo ? imageURL(company.logo, 'logo') : null,
      },
    })
  } catch (err) {
    console.log('❌ login', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const companyInfo = async (req, res) => {
  try {
    const { id } = req.user
    const { requires } = req.body
    await dbConnect()
    const company = await Company.findOne({ _id: id }, requires.join(' ')).lean()
    if (!company) return res.status(400).json({ msg: 'Company not found' })
    if (company.logo) company.logo = imageURL(company.logo, 'logo')

    // Ensure fallback values for seat fields if requested
    if (requires.includes('totalSeat') && company.totalSeat === undefined) {
      company.totalSeat = (company.seatCapacity || 0) + (company.seatPurchased || 0)
    }
    if (requires.includes('usedSeat') && company.usedSeat === undefined) {
      company.usedSeat = company.seatPurchased || 0
    }
    if (requires.includes('remainingSeat') && company.remainingSeat === undefined) {
      company.remainingSeat = company.seatCapacity || 0
    }

    delete company._id
    res.status(200).json({ status: true, data: company })
  } catch (err) {
    console.log('❌companyInfo err', err)
    res.status(401).json({ msg: err.message })
  }
}

const googleLogin = async (req, res) => {
  try {
    const { email, given_name, family_name, picture, companyName, customPlanUser } = req.body

    console.log('='.repeat(50))
    console.log('🌐 GOOGLE LOGIN API CALLED')
    console.log('Email:', email)
    console.log('='.repeat(50))

    if (!email) {
      return res.status(400).json({
        status: false,
        msg: 'Email is required for Google login',
      })
    }

    if (isTempEmail(email)) {
      return res.status(400).json({
        status: false,
        msg: 'Temporary email addresses are not allowed.',
      })
    }

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    // If logging in via a Custom Plan purchase link, enforce email match
    if (customPlanUser) {
      try {
        const assignedCompanyId = dec(customPlanUser, process.env.ID_SECRET)
        const assignedCompany = await Company.findById(assignedCompanyId, 'email').lean()
        if (assignedCompany && assignedCompany.email) {
          if (cleanEmail !== assignedCompany.email.trim().toLowerCase()) {
            console.log(`⛔ Custom plan Google login rejected: attempt by ${cleanEmail} for plan assigned to ${assignedCompany.email}`)
            return res.status(403).json({
              status: false,
              msg: `Access restricted: Only ${assignedCompany.email} is authorized to access and purchase this custom plan. You signed in with ${cleanEmail}.`,
            })
          }
        }
      } catch (decErr) {
        console.warn('⚠️ customPlanUser decryption error in googleLogin:', decErr.message)
      }
    }

    // Check if user already exists
    let company = await Company.findOne(
      { email: cleanEmail },
      '_id fName lName plan expiredAt totalSeat usedSeat remainingSeat seatCapacity seatPurchased companyName logo razorpayCustomerId email',
    ).lean()

    if (!company) {
      console.log('👤 Google signup check for:', cleanEmail)

      const trimmedCompanyName = (companyName || '').trim()

      // If company name is not provided yet, do NOT register the company yet!
      if (!trimmedCompanyName) {
        console.log('ℹ️ New user detected, requesting company name before registration')
        return res.status(200).json({
          status: true,
          requiresCompanyName: true,
          isNewUser: true,
          msg: 'Please enter company name to complete registration',
          data: {
            email: cleanEmail,
            given_name,
            family_name,
            picture,
          },
        })
      }

      console.log('👤 Registering new company for:', cleanEmail, 'with companyName:', trimmedCompanyName)

      // Create Razorpay customer for new user
      let razorpayCustomerId = null
      try {
        const customerName = `${given_name || ''} ${family_name || ''}`.trim() || trimmedCompanyName || 'Google User'
        const razorpayCustomer = await upsertRazorpayCustomer(customerName, cleanEmail)

        if (razorpayCustomer && razorpayCustomer.id) {
          razorpayCustomerId = razorpayCustomer.id
          console.log(`✅ Razorpay customer created: ${razorpayCustomerId}`)
        }
      } catch (razorpayError) {
        console.warn('⚠️ Razorpay customer creation failed:', razorpayError.message)
      }

      // Create new company only AFTER company name is entered
      const newCompanyData = {
        companyId: generateId(),
        email: cleanEmail,
        fName: given_name || 'Google',
        lName: family_name || 'User',
        companyName: trimmedCompanyName,
        razorpayCustomerId: razorpayCustomerId,
        isEmailVerified: true,
        createdAt: now(),
        updatedAt: now(),
      }

      if (picture) {
        newCompanyData.logo = picture
      }

      const newCompany = await Company.create(newCompanyData)
      console.log(`✅ New company registered: ${newCompany._id} (${newCompany.companyName}) with Razorpay ID: ${razorpayCustomerId}`)

      // Create default admin config
      setImmediate(async () => {
        try {
          await AdminConfig.create({
            owner: newCompany._id,
            metaKey: 'autoLocation',
            metaValue: 1,
            createdAt: now(),
            updatedAt: now(),
          })
        } catch (configError) {
          console.warn('⚠️ Admin config creation failed:', configError.message)
        }
      })

      // Send welcome email (background)
      setImmediate(async () => {
        try {
          await queueMail(cleanEmail, 'Welcome to GPS Map Camera ENT', 'welcome', {
            name: given_name || 'User',
            email: cleanEmail,
            companyName: newCompany.companyName || `${given_name || ''} ${family_name || ''}`.trim(),
            companyId: newCompany.companyId,
          })
          console.log(`📧 Welcome email sent to ${cleanEmail}`)
        } catch (emailError) {
          console.error('Welcome email error:', emailError.message)
        }
      })

      company = newCompany
    } else {
      console.log('✅ Existing user found:', company._id)

      // If existing company had no companyName and one was provided, update it
      if (!company.companyName && companyName && companyName.trim()) {
        const trimmedCompanyName = companyName.trim()
        await Company.updateOne({ _id: company._id }, { companyName: trimmedCompanyName, updatedAt: now() })
        company.companyName = trimmedCompanyName
        console.log(`✅ Updated company name for existing company ${company._id}: "${trimmedCompanyName}"`)
      }

      // Update logo if missing
      if (picture && !company.logo) {
        await Company.updateOne({ _id: company._id }, { logo: picture, updatedAt: now() })
        company.logo = picture
      }

      // Create Razorpay customer if missing
      if (!company.razorpayCustomerId) {
        console.log('⚠️ Existing user missing Razorpay ID, creating...')
        try {
          const customerName = `${company.fName || ''} ${company.lName || ''}`.trim() || 'User'
          const razorpayCustomer = await upsertRazorpayCustomer(customerName, cleanEmail)

          if (razorpayCustomer && razorpayCustomer.id) {
            await Company.updateOne({ _id: company._id }, { razorpayCustomerId: razorpayCustomer.id })
            company.razorpayCustomerId = razorpayCustomer.id
            console.log(`✅ Updated existing user with Razorpay ID: ${razorpayCustomer.id}`)
          }
        } catch (razorpayError) {
          console.warn('⚠️ Failed to create Razorpay customer for existing user:', razorpayError.message)
        }
      }
    }

    // Generate JWT token
    const user = { id: company._id }
    const accessToken = jwt.sign({ user }, process.env.JWT_SECRET, { expiresIn: '30d' })

    // Check plan status
    const now_ts = Math.round(Date.now() / 1000)
    const isPlanActive = company.plan && company.expiredAt && company.expiredAt > now_ts

    const logoResponse = company.logo ? imageURL(company.logo, 'logo') : null

    console.log('✅ Google login successful for:', cleanEmail)

    const gTotalSeat = company.totalSeat !== undefined ? company.totalSeat : (company.seatCapacity || 0) + (company.seatPurchased || 0)
    const gUsedSeat = company.usedSeat !== undefined ? company.usedSeat : company.seatPurchased || 0
    const gRemainingSeat = company.remainingSeat !== undefined ? company.remainingSeat : company.seatCapacity || 0

    res.status(200).json({
      status: true,
      msg: 'Login successfully',
      data: {
        accessToken,
        plan: company.plan || null,
        totalSeat: gTotalSeat,
        usedSeat: gUsedSeat,
        remainingSeat: gRemainingSeat,
        seatCapacity: gRemainingSeat,
        seatPurchased: gUsedSeat,
        isPlanActive: isPlanActive,
        expiredAt: company.expiredAt || null,
        companyName: company.companyName || null,
        logo: logoResponse,
        userEmail: company.email,
        userName: `${company.fName || ''} ${company.lName || ''}`.trim(),
      },
    })
  } catch (err) {
    console.error('❌ googleLogin error:', err)
    res.status(500).json({
      status: false,
      msg: 'Google login failed. Please try again.',
    })
  }
}

const changePassword = async (req, res) => {
  try {
    const { id } = req.user
    const { oldpassword, newpassword } = req.body

    if (!oldpassword) return res.status(400).json({ msg: { oldpassword: 'Old password is required' } })
    if (!newpassword) return res.status(400).json({ msg: { newpassword: 'New password is required' } })

    await dbConnect()

    const company = await Company.findOne({ _id: id }, 'password').lean()
    if (!company) return res.status(400).json({ msg: 'Company not found' })

    if (company.password !== enc(oldpassword, process.env.PASSWORD_SECRET))
      return res.status(400).json({ msg: { oldpassword: 'Incorrect current password' } })

    if (enc(oldpassword, process.env.PASSWORD_SECRET) === enc(newpassword, process.env.PASSWORD_SECRET)) {
      return res.status(400).json({ msg: { newpassword: 'New password must be different from current password' } })
    }
    await Company.updateOne({ _id: id }, { password: enc(newpassword, process.env.PASSWORD_SECRET) })
    createLog(id, 'Password Changed', 'Changed password using old password')
    res.status(200).json({ status: true, msg: 'Password updated successfully' })
  } catch (err) {
    console.log('❌ changePassword err', err)
    res.status(501).json({ msg: { confirmPassword: err.message } })
  }
}

const verifyOTP = async (req, res) => {
  console.log('='.repeat(50))
  console.log('🔐 OTP VERIFICATION REQUEST')
  console.log('Time:', new Date().toISOString())
  console.log('Email:', req.body.email)
  console.log('OTP Received:', req.body.otp)
  console.log('='.repeat(50))

  try {
    const { email, otp } = req.body

    // Validation
    if (!email || !email.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Email is required',
      })
    }

    if (!otp || otp.length !== 6) {
      return res.status(400).json({
        status: false,
        msg: 'Please enter valid 6 digit OTP',
      })
    }

    const cleanEmail = email.trim().toLowerCase()

    console.log('🔗 Connecting to database...')
    await dbConnect()

    // Check if already registered
    const alreadyRegistered = await Company.findOne({ email: cleanEmail }, '_id').lean()
    if (alreadyRegistered) {
      // Clean up pending signup if exists
      await PendingSignup.deleteOne({ email: cleanEmail }).catch(() => {})
      return res.status(400).json({
        status: false,
        msg: 'Email already verified. Please login.',
      })
    }

    // Find pending signup
    const pending = await PendingSignup.findOne({ email: cleanEmail }).lean()

    if (!pending) {
      console.log('❌ Pending signup not found:', cleanEmail)
      return res.status(400).json({
        status: false,
        msg: 'Email not found. Please sign up first.',
      })
    }

    console.log('📊 Pending signup check:')
    console.log('- Stored OTP:', pending.otp)
    console.log('- User OTP:', otp)
    console.log('- OTP Expiry:', pending.otpExpiry)
    console.log('- Current time:', now())
    console.log('- OTP Valid:', pending.otpExpiry > now())

    // Check OTP expiration
    if (pending.otpExpiry < now()) {
      console.log('❌ OTP expired')
      return res.status(400).json({
        status: false,
        msg: 'OTP has expired. Please request a new one.',
      })
    }

    // Check OTP match
    if (pending.otp !== otp.toString()) {
      console.log('❌ OTP mismatch')
      return res.status(400).json({
        status: false,
        msg: 'Invalid OTP. Please enter the correct verification code.',
      })
    }

    // ✅ OTP IS VALID - Create Razorpay customer first
    console.log('✅ OTP verified! Creating Razorpay customer...')

    let razorpayCustomerId = null
    try {
      const customerName = `${pending.fName} ${pending.lName}`.trim()
      const razorpayCustomer = await upsertRazorpayCustomer(customerName, cleanEmail)

      if (razorpayCustomer && razorpayCustomer.id) {
        razorpayCustomerId = razorpayCustomer.id
        console.log(`✅ Razorpay customer ID: ${razorpayCustomerId} for email: ${cleanEmail}`)
      } else {
        console.warn(`⚠️ Razorpay customer creation returned null for: ${cleanEmail}`)
      }
    } catch (err) {
      console.error('❌ Razorpay customer creation failed:', err.message)
      // Continue without Razorpay customer - can be created later
    }

    // Generate unique company ID
    const companyId = generateId()

    // Create Company document
    console.log('📝 Creating Company document...')
    const companyData = {
      companyId,
      fName: pending.fName,
      lName: pending.lName,
      companyName: pending.companyName || null,
      email: cleanEmail,
      password: pending.password,
      razorpayCustomerId: razorpayCustomerId, // This will be unique per user
      isEmailVerified: true,
      createdAt: pending.createdAt || now(),
      updatedAt: now(),
    }

    console.log('Company data to create:', { ...companyData, password: '***', razorpayCustomerId })

    const createdCompany = await Company.create(companyData)
    console.log(`✅ Company created: ${createdCompany._id} with Razorpay ID: ${razorpayCustomerId}`)

    // Remove pending signup
    try {
      await PendingSignup.deleteOne({ email: cleanEmail })
      console.log('🧹 Removed pending signup for:', cleanEmail)
    } catch (delErr) {
      console.warn('⚠️ Failed to remove pending signup:', delErr.message)
    }

    // Create default admin config (background)
    setImmediate(async () => {
      try {
        await AdminConfig.create({
          owner: createdCompany._id,
          metaKey: 'autoLocation',
          metaValue: 1,
          createdAt: now(),
          updatedAt: now(),
        })
        console.log('✅ Default admin config created')
      } catch (configError) {
        console.warn('⚠️ Admin config creation failed:', configError.message)
      }
    })

    // Send welcome email (background)
    setImmediate(async () => {
      try {
        await queueMail(cleanEmail, 'Welcome to GPS Map Camera ENT', 'welcome', {
          name: pending.fName,
          email: cleanEmail,
          companyName: createdCompany.companyName || `${pending.fName} ${pending.lName}`.trim(),
          companyId: companyId,
        })
        console.log(`📧 Welcome email sent to ${cleanEmail}`)
      } catch (emailError) {
        console.error('Welcome email error:', emailError.message)
      }
    })

    // Success response
    res.status(200).json({
      status: true,
      msg: 'Email verified successfully! You can now login.',
      email: cleanEmail,
      verifiedAt: now(),
    })

    console.log('='.repeat(50))
    console.log(`🎉 OTP VERIFICATION COMPLETE FOR: ${cleanEmail}`)
    console.log(`🔑 Razorpay Customer ID: ${razorpayCustomerId}`)
    console.log('='.repeat(50))
  } catch (err) {
    console.error('❌ verifyOTP error:', err)
    console.error('Stack trace:', err.stack)

    // Handle duplicate key error
    if (err.code === 11000) {
      return res.status(400).json({
        status: false,
        msg: 'Account already exists. Please login.',
      })
    }

    res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    })
  }
}

const regenerateOTP = async (req, res) => {
  console.log('='.repeat(50))
  console.log('🔄 REGENERATE OTP REQUEST')
  console.log('Time:', new Date().toISOString())
  console.log('Email:', req.body.email)
  console.log('='.repeat(50))

  try {
    const { email } = req.body

    if (!email) {
      return res.status(400).json({ status: false, msg: 'Email is required' })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ status: false, msg: 'Invalid email address' })
    }

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    // Check if already registered
    const alreadyRegistered = await Company.findOne({ email: cleanEmail }, '_id').lean()
    if (alreadyRegistered) {
      return res.status(400).json({
        status: false,
        msg: 'Email already verified. Please login.',
      })
    }

    // Find pending signup
    const pending = await PendingSignup.findOne({ email: cleanEmail }).lean()
    if (!pending) {
      return res.status(400).json({
        status: false,
        msg: 'Email not found. Please sign up first.',
      })
    }

    // Rate limiting - max 5 OTP requests per email in 15 minutes
    const fifteenMinutesAgo = now() - 900
    if (pending.lastOtpSentAt && pending.otpSentCount >= 5 && pending.lastOtpSentAt > fifteenMinutesAgo) {
      return res.status(429).json({
        status: false,
        msg: 'Too many OTP requests. Please try again after 15 minutes.',
      })
    }

    const newOtp = Math.floor(100000 + Math.random() * 900000)
    const otpExpiry = now() + 300 // 5 minutes

    console.log(`🎉 New OTP generated for ${cleanEmail}: ${newOtp}`)

    // Send OTP email
    console.log('📧 Sending new OTP email...')
    let emailSent = false

    try {
      await queueMail(cleanEmail, 'New Verification OTP - GPS Map Camera ENT', 'otp', {
        otp: newOtp.toString(),
        name: pending.fName || 'User',
        expiry: '5 minutes',
      })
      emailSent = true
      console.log(`✅ New OTP email sent successfully to ${cleanEmail}`)
    } catch (err) {
      console.error('❌ Error sending new OTP email:', err.message)
    }

    // Update OTP in pending signup
    const updateData = {
      otp: newOtp.toString(),
      otpExpiry: otpExpiry,
      lastOtpSentAt: now(),
      $inc: { otpSentCount: 1 },
    }

    // Reset count if it's been more than 15 minutes
    if (!pending.lastOtpSentAt || pending.lastOtpSentAt <= fifteenMinutesAgo) {
      updateData.otpSentCount = 1
    }

    await PendingSignup.updateOne({ email: cleanEmail }, updateData)

    console.log(`✅ OTP updated in pending signup for ${cleanEmail}`)

    if (!emailSent) {
      return res.status(500).json({
        status: false,
        msg: 'Failed to send OTP email. Please try again later.',
      })
    }

    res.status(200).json({
      status: true,
      msg: 'New OTP sent successfully. Please check your email.',
      email: cleanEmail,
      emailSent: true,
    })

    console.log('='.repeat(50))
    console.log(`🎉 REGENERATE OTP COMPLETE FOR: ${cleanEmail}`)
    console.log('='.repeat(50))
  } catch (err) {
    console.error('❌ regenerateOTP error:', err)
    res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
    })
  }
}

const sendResetPasswordLink = async (req, res) => {
  console.log('='.repeat(50))
  console.log('📧 SEND RESET PASSWORD LINK API')
  console.log('Time:', new Date().toISOString())
  console.log('Request body:', req.body)
  console.log('='.repeat(50))

  try {
    const { email, userType } = req.body

    // Validate input
    if (!email || !email.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Email is required',
      })
    }

    if (!userType) {
      return res.status(400).json({
        status: false,
        msg: 'User type is required',
      })
    }

    const cleanEmail = email.trim().toLowerCase()

    // Validate email format
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({
        status: false,
        msg: 'Please enter a valid email address',
      })
    }

    await dbConnect()

    console.log('🔍 Looking for user with email:', cleanEmail)
    console.log('User type:', userType)

    let user
    if (userType === 'company') {
      user = await Company.findOne({ email: cleanEmail }, '_id fName email').lean()
      console.log('Company found:', user ? 'Yes' : 'No')
    } else if (userType === 'appUser') {
      user = await User.findOne({ email: cleanEmail }, '_id fname email').lean()
      console.log('App user found:', user ? 'Yes' : 'No')
    } else {
      return res.status(400).json({
        status: false,
        msg: 'Invalid user type',
      })
    }

    if (!user) {
      console.log('❌ User not found')
      return res.status(400).json({
        status: false,
        msg: 'No account found with this email address',
      })
    }

    console.log('✅ User found:', user._id)

    const userId = user._id.toString()
    const encryptedId = enc(userId, process.env.ID_SECRET)

    // Create JWT token
    const token = jwt.sign(
      {
        id: encryptedId,
        type: userType,
        email: cleanEmail,
      },
      process.env.JWT_SECRET,
      { expiresIn: '10m' },
    )

    console.log('Token created:', token ? 'Yes' : 'No')

    // Create reset URL
    const params = new URLSearchParams()
    params.set('token', token)
    params.set('userType', userType)

    const frontendUrl = process.env.FRONTEND_URI || 'http://localhost:1002'
    const url = `${frontendUrl}/resetpassword?${params.toString()}`

    console.log('Reset URL:', url)

    // Send email in background (don't wait)
    setTimeout(async () => {
      try {
        const userName = userType === 'company' ? user.fName : user.fname
        await queueMail(cleanEmail, 'Reset Your Password - GPS Map Camera ENT', 'resetpassword', {
          url,
          expireAt: dateConverter(now() + 600, 'llll') + ' (IST)',
          name: userName || 'User',
        })
        console.log(`📧 Reset password email sent to ${cleanEmail}`)
      } catch (emailError) {
        console.error('Email sending error:', emailError.message)
      }
    }, 0)

    // Create log in background
    setTimeout(async () => {
      try {
        await createLog(userId, 'Reset password link requested')
        console.log(`📋 Log created for user: ${userId}`)
      } catch (logError) {
        console.error('Log creation error:', logError.message)
      }
    }, 0)

    // Return success immediately
    res.status(200).json({
      status: true,
      msg: 'Reset password link has been sent to your email. Please check your inbox (and spam folder).',
      emailSent: true,
      note: 'For testing, you can check console for the reset URL',
    })
  } catch (err) {
    console.error('❌ sendResetPasswordLink error:', err)
    console.error('Stack trace:', err.stack)

    res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    })
  }
}

const resetPassword = async (req, res) => {
  console.log('='.repeat(50))
  console.log('🔐 RESET PASSWORD API')
  console.log('Time:', new Date().toISOString())
  console.log('Has token:', !!req.body.token)
  console.log('User type:', req.body.userType)
  console.log('='.repeat(50))

  try {
    const { token, password, userType } = req.body

    // Validate input
    if (!token) {
      return res.status(400).json({
        status: false,
        msg: 'Invalid request. Token is missing.',
      })
    }

    if (!password) {
      return res.status(400).json({
        status: false,
        msg: 'Password is required',
      })
    }

    if (!userType) {
      return res.status(400).json({
        status: false,
        msg: 'Invalid request',
      })
    }

    // Validate password strength
    const passwordValidation = isValidPassword(password)
    if (passwordValidation !== true) {
      return res.status(400).json({
        status: false,
        msg: passwordValidation,
      })
    }

    // Verify JWT token
    jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
      if (err) {
        console.log('JWT verification failed:', err.message)
        return res.status(401).json({
          status: false,
          msg: 'Reset link has expired. Please request a new one.',
        })
      }

      try {
        // Decrypt user ID
        const id = dec(decoded.id, process.env.ID_SECRET)
        const userEmail = decoded.email || 'Unknown'

        if (!id) {
          throw new Error('Invalid token payload')
        }

        console.log('Decrypted user ID:', id)
        console.log('User email:', userEmail)

        await dbConnect()

        let user
        let userName = ''
        let userEmailAddr = ''

        if (userType === 'company') {
          user = await Company.findOne({ _id: id }, 'email fName password').lean()
          if (user) {
            userName = user.fName || 'Company'
            userEmailAddr = user.email
          }
        } else if (userType === 'appUser') {
          user = await User.findOne({ _id: id }, 'email fname password').lean()
          if (user) {
            userName = user.fname || 'User'
            userEmailAddr = user.email
          }
        }

        if (!user) {
          console.log('User not found with ID:', id)
          return res.status(400).json({
            status: false,
            msg: 'Invalid request. User not found.',
          })
        }

        console.log('User found:', userEmailAddr)

        // Check if new password is same as old (optional)
        const encryptedNewPassword = enc(password, process.env.PASSWORD_SECRET)

        // Update password
        if (userType === 'company') {
          await Company.updateOne(
            { _id: id },
            {
              password: encryptedNewPassword,
              updatedAt: now(),
            },
          )
        } else if (userType === 'appUser') {
          await User.updateOne(
            { _id: id },
            {
              password: encryptedNewPassword,
              updatedAt: now(),
            },
          )
        }

        console.log('✅ Password updated successfully for:', userEmailAddr)

        // Send confirmation email in background
        setTimeout(async () => {
          try {
            const clientInfo = await getClientDetails(req)
            await queueMail(userEmailAddr, 'Password Reset Successful - GPS Map Camera ENT', 'passwordChanged', {
              fName: userName,
              ...clientInfo,
              timestamp: new Date().toISOString(),
            })
            console.log(`📧 Password change notification sent to ${userEmailAddr}`)
          } catch (emailError) {
            console.error('Notification email error:', emailError.message)
          }
        }, 0)

        // Create log in background
        setTimeout(async () => {
          try {
            await createLog(id, 'Password reset via reset link', 'Password was reset using the reset link')
            console.log(`📋 Password reset logged for user: ${id}`)
          } catch (logError) {
            console.error('Log creation error:', logError.message)
          }
        }, 0)

        // Return success
        return res.status(200).json({
          status: true,
          msg: 'Password reset successfully. You can now login with your new password.',
          email: userEmailAddr,
        })
      } catch (dbError) {
        console.error('Database error:', dbError)
        return res.status(500).json({
          status: false,
          msg: 'Something went wrong. Please try again.',
        })
      }
    })
  } catch (err) {
    console.error('❌ resetPassword error:', err)
    console.error('Stack trace:', err.stack)

    res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
    })
  }
}

const sendQuery = async (req, res) => {
  console.log('='.repeat(50))
  console.log('📞 SEND QUERY API CALLED')
  console.log('Time:', new Date().toISOString())
  console.log('User ID:', req.user?.id)
  console.log('Body:', req.body)
  console.log('='.repeat(50))

  try {
    const contactPersonData = req.body
    const { name, email, type, contactNum, phoneCode, msg } = contactPersonData

    // Validate required fields
    const errors = {}

    if (!name || !name.trim()) {
      errors.name = 'Name is required'
    }

    if (!email || !email.trim()) {
      errors.email = 'Please enter email'
    } else if (!isValidEmail(email)) {
      errors.email = 'Please enter valid email address'
    }

    if (!contactNum) {
      errors.contactNum = 'Please enter contact number'
    } else if (!isValidMobile(contactNum)) {
      errors.contactNum = 'Please enter valid contact number'
    }

    if (!phoneCode) {
      errors.phoneCode = 'Please select phone code'
    }

    if (!type) {
      errors.type = 'Issue type is required'
    }

    if (!msg || !msg.trim()) {
      errors.msg = 'Message is required'
    } else if (msg.length < 100) {
      errors.msg = 'Message should be at least 100 characters'
    } else if (msg.length > 500) {
      errors.msg = 'Message should be at most 500 characters'
    }

    // If there are validation errors, return them
    if (Object.keys(errors).length > 0) {
      console.log('❌ Validation errors:', errors)
      return res.status(400).json({
        status: false,
        msg: 'Validation failed',
        errors: errors,
      })
    }

    // Check if user is authenticated
    if (!req.user || !req.user.id) {
      console.log('❌ User not authenticated')
      return res.status(401).json({
        status: false,
        msg: 'Authentication required',
      })
    }

    const { id } = req.user

    await dbConnect()

    // Get company data
    const companyData = await Company.findOne({ _id: id }, 'fName lName email companyId companyName plan expiredAt').lean()

    if (!companyData) {
      console.log('❌ Company not found for ID:', id)
      return res.status(400).json({
        status: false,
        msg: 'Company not found',
      })
    }

    console.log('✅ Company found:', companyData.companyName)

    // Format phone number
    const fullPhoneNumber = `${phoneCode}${contactNum}`

    // Format expiry date
    let planExpiry = 'N/A'
    if (companyData.expiredAt) {
      try {
        planExpiry = dateConverter(companyData.expiredAt, 'Do MMMM YYYY, h:mm:ss a')
      } catch (dateError) {
        console.error('Date conversion error:', dateError)
        planExpiry = new Date(companyData.expiredAt).toLocaleDateString()
      }
    }

    // Prepare email data
    const emailData = {
      contactPersonName: name.trim(),
      phone: fullPhoneNumber,
      personEmail: email.trim().toLowerCase(),
      companyName: companyData.companyName || 'N/A',
      companyEmail: companyData.email || 'N/A',
      companyUserName: `${companyData.fName || ''} ${companyData.lName || ''}`.trim(),
      plan: companyData?.plan || 'N/A',
      planExpiry: planExpiry,
      companyId: companyData.companyId || 'N/A',
      type: type || 'General',
      msg: msg.trim(),
    }

    console.log('📧 Sending email with data:', emailData)

    // Send email (non-blocking)
    setTimeout(async () => {
      const primary = (process.env.QUERY_SENT_TO || process.env.MAIL_SENDBY || 'ent-support@gpsmapcamera.com').trim()
      const fallback = (process.env.MAIL_SENDBY || 'ent-support@gpsmapcamera.com').trim()
      console.log(`📧 Attempting to send enquiry to primary recipient: ${primary}`)
      try {
        await queueMail(primary, 'New Enquiry from GPS Map Camera ENT', 'query', emailData)
        console.log(`✅ Enquiry email sent to primary recipient: ${primary}`)
      } catch (emailError) {
        console.error(`❌ Enquiry email to ${primary} failed:`, emailError.message)
        if (fallback && fallback !== primary) {
          console.log(`🔁 Attempting fallback recipient: ${fallback}`)
          try {
            await queueMail(fallback, 'New Enquiry from GPS Map Camera ENT', 'query', emailData)
            console.log(`✅ Enquiry email sent to fallback recipient: ${fallback}`)
          } catch (fallbackErr) {
            console.error(`❌ Fallback email to ${fallback} also failed:`, fallbackErr.message)
          }
        }
      }
    }, 0)

    // Create log (non-blocking)
    setTimeout(async () => {
      try {
        await createLog(id, 'Left a Query', `Type: ${type}`)
        console.log('📋 Log created')
      } catch (logError) {
        console.error('Log creation error:', logError.message)
      }
    }, 0)

    // Return success immediately
    res.status(200).json({
      status: true,
      msg: 'Query sent successfully. We will contact you soon.',
      data: {
        queryId: `query_${Date.now()}`,
        submittedAt: new Date().toISOString(),
        email: emailData.personEmail,
      },
    })

    console.log('✅ Query submitted successfully')
  } catch (err) {
    console.error('❌ sendQuery error:', err)
    console.error('Stack trace:', err.stack)

    res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    })
  }
}

const sendFeedback = async (req, res) => {
  console.log('='.repeat(50))
  console.log('📝 FEEDBACK API CALLED')
  console.log('Time:', new Date().toISOString())
  console.log('User ID:', req.user?.id)
  console.log('Message length:', req.body.msg?.length)
  console.log('='.repeat(50))

  try {
    const { msg, type } = req.body

    // Validate feedback
    if (!type) {
      return res.status(400).json({
        status: false,
        msg: 'Feedback type is required',
      })
    }

    if (!msg || !msg.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Message is required',
      })
    }

    const cleanMsg = msg.trim()

    if (cleanMsg.length < 100) {
      return res.status(400).json({
        status: false,
        msg: 'Message should be at least 100 characters',
      })
    }

    if (cleanMsg.length > 500) {
      return res.status(400).json({
        status: false,
        msg: 'Message should be at most 500 characters',
      })
    }

    const { id } = req.user

    if (!id) {
      return res.status(401).json({
        status: false,
        msg: 'Authentication required',
      })
    }

    await dbConnect()

    // Get company info
    const company = await Company.findOne({ _id: id }, 'companyName email plan fName lName').lean()

    if (!company) {
      return res.status(400).json({
        status: false,
        msg: 'Company not found',
      })
    }

    console.log('Company found:', company.email)

    // Rate limiting check (optional - uncomment if needed)
    const userPastFeedback = await UserFeedback.countDocuments({
      user: id,
      createdAt: { $gt: now() - 86400 },
    }).lean()

    if (userPastFeedback >= 2) {
      return res.status(400).json({
        status: false,
        msg: 'You can only send 2 feedbacks in a day',
      })
    }

    // Save feedback to database
    await UserFeedback.create({
      user: id,
      type,
      msg: cleanMsg,
      createdAt: now(),
    })

    // Send email in background (don't wait for it)
    setTimeout(async () => {
      try {
        await queueMail(
          process.env.MAIL_SENDBY || 'ent-support@gpsmapcamera.com',
          `New Feedback [${type}] - ${company.companyName || company.fName}`,
          'newFeedback',
          {
            companyName: company.companyName || 'N/A',
            userName: `${company.fName || ''} ${company.lName || ''}`.trim(),
            email: company.email || 'N/A',
            type: type,
            msg: cleanMsg,
            plan: company?.plan || 'N/A',
            timestamp: new Date().toISOString(),
          },
        )
        console.log(`📧 Feedback email sent for user: ${id}`)
      } catch (emailError) {
        console.error('Feedback email error:', emailError.message)
      }
    }, 0)

    // Create log in background
    setTimeout(async () => {
      try {
        await createLog(id, 'Left a feedback', `Type: ${type} - ${cleanMsg.substring(0, 100)}...`)
        console.log(`📋 Feedback logged for user: ${id}`)
      } catch (logError) {
        console.error('Log creation error:', logError.message)
      }
    }, 0)

    // Return success IMMEDIATELY
    res.status(200).json({
      status: true,
      msg: 'Feedback submitted successfully. Thank you!',
      messageLength: cleanMsg.length,
    })

    console.log('✅ Feedback submitted successfully')
  } catch (err) {
    console.error('❌ sendFeedback error:', err)
    console.error('Stack trace:', err.stack)

    res.status(500).json({
      status: false,
      msg: 'Failed to submit feedback. Please try again.',
      error: process.env.NODE_ENV !== 'production' ? err.message : undefined,
    })
  }
}

module.exports = {
  signUp,
  login,
  companyInfo,
  googleLogin,
  changePassword,
  verifyOTP,
  regenerateOTP,
  sendResetPasswordLink,
  resetPassword,
  sendQuery,
  sendFeedback,
}

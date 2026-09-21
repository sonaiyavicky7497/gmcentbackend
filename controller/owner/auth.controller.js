// controller/owner/auth.controller.js
const Owner = require('../../models/Owner.model')
const Company = require('../../models/Company.model')
const dbConnect = require('../../utils/dbConnect')
const jwt = require('jsonwebtoken')
// Added queueMail to imports
const { enc, dec, isValidEmail, isTempEmail, queueMail } = require('../../utils/utilities')

const resolveOwnerCompanyContext = async (email) => {
  try {
    const cleanEmail = String(email || '')
      .trim()
      .toLowerCase()
    if (!cleanEmail) return {}

    await dbConnect()
    const company = await Company.findOne({ email: cleanEmail }, '_id companyId').lean()

    if (!company) return {}

    return {
      companyId: company._id.toString(),
      companyCode: company.companyId || null,
    }
  } catch (error) {
    console.error('resolveOwnerCompanyContext error:', error)
    return {}
  }
}

// --- LOGIN ---
const ownerLogin = async (req, res) => {
  console.log('='.repeat(50))
  console.log('👑 OWNER LOGIN API CALLED')

  try {
    const { email, password } = req.body

    if (!email || !email.trim()) return res.status(400).json({ status: false, msg: 'Email is required' })
    if (!password) return res.status(400).json({ status: false, msg: 'Password is required' })

    const cleanEmail = email.trim().toLowerCase()

    await dbConnect()

    // Find user
    const user = await Owner.findOne({ email: cleanEmail }).lean()

    if (!user) return res.status(400).json({ status: false, msg: 'Invalid credentials' })
    if (dec(user.password, process.env.PASSWORD_SECRET) !== password) return res.status(400).json({ status: false, msg: 'Invalid credentials' })

    // CRITICAL: Block login if account is not verified (status 0)
    if (user.status !== 1) return res.status(400).json({ status: false, msg: 'Account not verified. Please complete signup.' })

    const ownerCompanyContext = await resolveOwnerCompanyContext(cleanEmail)
    const accessToken = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
        type: 'owner',
        ...ownerCompanyContext,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' },
    )

    res.status(200).json({
      status: true,
      msg: 'Login Successfully',
      data: { accessToken },
    })
  } catch (err) {
    console.error('❌ ownerLogin error:', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

// --- STEP 1: SIGNUP REQUEST (Validate details & Send OTP via Email) ---
const ownerSignupRequest = async (req, res) => {
  console.log('='.repeat(50))
  console.log('👑 OWNER SIGNUP REQUEST CALLED')
  console.log('Body:', { ...req.body, password: '***' })

  try {
    const { email, password, role } = req.body

    // 1. Validation
    if (!email || !isValidEmail(email)) return res.status(400).json({ status: false, msg: 'Valid email required' })
    if (isTempEmail(email)) return res.status(400).json({ status: false, msg: 'Temporary emails not allowed' })
    if (!password || password.length < 8) return res.status(400).json({ status: false, msg: 'Password min 8 chars' })
    if (!role) return res.status(400).json({ status: false, msg: 'Role required' })

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    // 2. Check if user exists
    let user = await Owner.findOne({ email: cleanEmail })

    // 3. Generate OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpExpire = Math.floor(Date.now() / 1000) + 10 * 60 // 10 mins
    const encryptedPassword = enc(password, process.env.PASSWORD_SECRET)

    if (user) {
      // If user exists and is ACTIVE (1), prevent signup
      if (user.status === 1) {
        return res.status(400).json({ status: false, msg: 'Email already registered. Please login.' })
      }

      // If user exists but is INACTIVE (0), update details and resend OTP
      user.password = encryptedPassword
      user.role = parseInt(role)
      user.otp = otp
      user.otpExpire = otpExpire
      user.updatedAt = Math.floor(Date.now() / 1000)
      await user.save()
      console.log(`🔁 Inactive owner updated: ${cleanEmail}`)
    } else {
      // Create new INACTIVE user
      user = await Owner.create({
        email: cleanEmail,
        password: encryptedPassword,
        role: parseInt(role),
        status: 0, // INACTIVE
        otp,
        otpExpire,
        createdAt: Math.floor(Date.now() / 1000),
      })
      console.log(`✅ New owner created (inactive): ${user._id}`)
    }

    // 4. Send OTP Email
    console.log(`✉️ Sending OTP to ${cleanEmail}... (OTP: ${otp})`)
    let emailSent = false
    let emailError = null

    try {
      // Use the name from email prefix since we don't have fName/lName
      const name = cleanEmail.split('@')[0]

      await queueMail(cleanEmail, 'Email Verification OTP - GPS Map Camera ENT', 'otp', {
        otp: otp.toString(),
        name: name,
        expiry: '10 minutes',
      })
      emailSent = true
      console.log(`✅ OTP email sent successfully to ${cleanEmail}`)
    } catch (err) {
      emailError = err
      console.error('❌ Error sending OTP email:', err.message)
    }

    // If email failed, return success with warning (so user knows account is created but email failed)
    if (!emailSent) {
      return res.status(200).json({
        status: true,
        msg: 'Account created, but email failed. Please try "Resend OTP".',
        emailSent: false,
        warning: 'Email delivery failed',
      })
    }

    res.status(200).json({
      status: true,
      msg: 'OTP sent to your email address',
      emailSent: true,
    })
  } catch (err) {
    console.error('❌ Signup Request Error:', err)
    res.status(500).json({ status: false, msg: 'Server error' })
  }
}

// --- STEP 2: SIGNUP VERIFY (Check OTP & Activate) ---
const ownerSignupVerify = async (req, res) => {
  try {
    const { email, otp } = req.body

    if (!email || !otp) return res.status(400).json({ status: false, msg: 'Missing fields' })

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    const user = await Owner.findOne({ email: cleanEmail })

    if (!user) return res.status(404).json({ status: false, msg: 'User not found' })
    if (user.status === 1) return res.status(400).json({ status: false, msg: 'Account already verified' })

    // Verify OTP
    const currentTime = Math.floor(Date.now() / 1000)
    if (user.otp !== otp) return res.status(400).json({ status: false, msg: 'Invalid OTP' })
    if (user.otpExpire < currentTime) return res.status(400).json({ status: false, msg: 'OTP expired' })

    // Activate User
    user.status = 1
    user.otp = null
    user.otpExpire = null
    await user.save()

    // Login user immediately
    const ownerCompanyContext = await resolveOwnerCompanyContext(cleanEmail)
    const accessToken = jwt.sign(
      {
        id: user._id,
        email: user.email,
        role: user.role,
        type: 'owner',
        ...ownerCompanyContext,
      },
      process.env.JWT_SECRET,
      { expiresIn: '30d' },
    )

    console.log(`🎉 Owner verified and logged in: ${cleanEmail}`)

    res.status(200).json({
      status: true,
      msg: 'Account verified successfully!',
      data: { accessToken, role: user.role },
    })
  } catch (err) {
    console.error('Signup Verify Error:', err)
    res.status(500).json({ status: false, msg: 'Server error' })
  }
}

// --- FORGOT PASSWORD ---
const ownerForgotPassword = async (req, res) => {
  try {
    const { email } = req.body
    if (!email) return res.status(400).json({ status: false, msg: 'Email is required' })

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    const user = await Owner.findOne({ email: cleanEmail })
    if (!user) return res.status(404).json({ status: false, msg: 'Email not found' })

    // Generate 6 digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpExpire = Math.floor(Date.now() / 1000) + 10 * 60 // 10 minutes

    user.otp = otp
    user.otpExpire = otpExpire
    await user.save()

    // Send Email
    try {
      const name = cleanEmail.split('@')[0]
      await queueMail(cleanEmail, 'Password Reset OTP - GPS Map Camera ENT', 'otp', {
        otp: otp.toString(),
        name: name,
        expiry: '10 minutes',
      })
      console.log(`✅ Forgot Password OTP sent to ${cleanEmail}`)
    } catch (err) {
      console.error('❌ Error sending Forgot Password OTP:', err.message)
      return res.status(500).json({ status: false, msg: 'Failed to send email' })
    }

    res.status(200).json({ status: true, msg: 'OTP sent to your email' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ status: false, msg: 'Server error' })
  }
}

// --- VERIFY OTP (Forgot Password) ---
const ownerVerifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body
    if (!email || !otp) return res.status(400).json({ status: false, msg: 'Email and OTP required' })

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    const user = await Owner.findOne({ email: cleanEmail })
    if (!user) return res.status(404).json({ status: false, msg: 'User not found' })

    const currentTime = Math.floor(Date.now() / 1000)

    if (user.otp !== otp) return res.status(400).json({ status: false, msg: 'Invalid OTP' })
    if (user.otpExpire < currentTime) return res.status(400).json({ status: false, msg: 'OTP has expired' })

    res.status(200).json({ status: true, msg: 'OTP Verified' })
  } catch (err) {
    console.error(err)
    res.status(500).json({ status: false, msg: 'Server error' })
  }
}

// --- RESET PASSWORD ---
const ownerResetPassword = async (req, res) => {
  try {
    const { email, otp, password } = req.body

    if (!email || !otp || !password) return res.status(400).json({ status: false, msg: 'All fields required' })
    if (password.length < 8) return res.status(400).json({ status: false, msg: 'Password too short' })

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    const user = await Owner.findOne({ email: cleanEmail })
    if (!user) return res.status(404).json({ status: false, msg: 'User not found' })

    const currentTime = Math.floor(Date.now() / 1000)
    if (user.otp !== otp || user.otpExpire < currentTime) {
      return res.status(400).json({ status: false, msg: 'Invalid or expired OTP' })
    }

    // ✅ NEW: Check if new password is same as old password
    const encryptedNewPassword = enc(password, process.env.PASSWORD_SECRET)
    const currentPassword = user.password // This is the encrypted current password

    // Compare encrypted passwords
    if (encryptedNewPassword === currentPassword) {
      return res.status(400).json({
        status: false,
        msg: 'New password cannot be the same as your current password',
      })
    }

    console.log('🔍 Password comparison:', {
      newPasswordEncrypted: encryptedNewPassword.substring(0, 20) + '...',
      currentPasswordEncrypted: currentPassword.substring(0, 20) + '...',
      isSame: encryptedNewPassword === currentPassword,
    })

    user.password = encryptedNewPassword
    user.otp = null
    user.otpExpire = null
    await user.save()

    // Send notification email
    try {
      const name = cleanEmail.split('@')[0]
      await queueMail(cleanEmail, 'Password Reset Successful - GPS Map Camera ENT', 'passwordChangedOwner', {
        name: name,
        timestamp: new Date().toLocaleString(),
        note: 'Your password was reset via the forgot password flow.',
      })
      console.log(`✅ Password reset notification sent to ${cleanEmail}`)
    } catch (emailError) {
      console.error('Password reset notification email error:', emailError.message)
      // Don't fail the request if email fails
    }

    res.status(200).json({
      status: true,
      msg: 'Password reset successfully. You can now login with your new password.',
    })
  } catch (err) {
    console.error(err)
    res.status(500).json({ status: false, msg: 'Server error' })
  }
}

// --- RESEND OTP ---
const ownerResendOtp = async (req, res) => {
  console.log('='.repeat(50))
  console.log('🔄 OWNER RESEND OTP API CALLED')
  console.log('Body:', req.body)

  try {
    const { email, purpose } = req.body

    // Validation
    if (!email) return res.status(400).json({ status: false, msg: 'Email is required' })
    if (!purpose || !['signup', 'forgot-password'].includes(purpose)) {
      return res.status(400).json({
        status: false,
        msg: 'Valid purpose required: "signup" or "forgot-password"',
      })
    }

    await dbConnect()
    const cleanEmail = email.trim().toLowerCase()

    // Find user
    const user = await Owner.findOne({ email: cleanEmail })
    if (!user) {
      return res.status(404).json({
        status: false,
        msg: purpose === 'signup' ? 'Email not found. Please sign up first.' : 'Email not found. Please check your email address.',
      })
    }

    // Check user status based on purpose
    if (purpose === 'signup') {
      // For signup, user should be inactive (status 0)
      if (user.status === 1) {
        return res.status(400).json({
          status: false,
          msg: 'Account already verified. Please login.',
        })
      }
    } else if (purpose === 'forgot-password') {
      // For forgot-password, user should be active (status 1)
      if (user.status === 0) {
        return res.status(400).json({
          status: false,
          msg: 'Account not verified. Please complete signup first.',
        })
      }
    }

    // Generate new OTP
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString()
    const otpExpire = Math.floor(Date.now() / 1000) + 10 * 60 // 10 minutes

    // Update OTP in database
    user.otp = newOtp
    user.otpExpire = otpExpire
    user.updatedAt = Math.floor(Date.now() / 1000)
    await user.save()

    console.log(`🔄 New OTP generated for ${cleanEmail} (${purpose}): ${newOtp}`)

    // Send OTP Email
    let emailSent = false
    let emailError = null

    try {
      const name = cleanEmail.split('@')[0]
      const subject = purpose === 'signup' ? 'New Email Verification OTP - GPS Map Camera ENT' : 'New Password Reset OTP - GPS Map Camera ENT'

      await queueMail(cleanEmail, subject, 'otp', {
        otp: newOtp.toString(),
        name: name,
        expiry: '10 minutes',
        purpose: purpose === 'signup' ? 'email verification' : 'password reset',
      })

      emailSent = true
      console.log(`✅ New OTP email sent successfully to ${cleanEmail} for ${purpose}`)
    } catch (err) {
      emailError = err
      console.error(`❌ Error sending ${purpose} OTP email:`, err.message)
    }

    // Handle email failure
    if (!emailSent) {
      return res.status(500).json({
        status: false,
        msg: 'Failed to send OTP email. Please try again.',
        emailSent: false,
      })
    }

    res.status(200).json({
      status: true,
      msg: `New OTP sent to your email address for ${purpose === 'signup' ? 'verification' : 'password reset'}`,
      emailSent: true,
      purpose: purpose,
    })

    console.log(`🎉 Resend OTP successful for ${purpose}: ${cleanEmail}`)
  } catch (err) {
    console.error('❌ ownerResendOtp error:', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

module.exports = {
  ownerLogin,
  ownerSignupRequest,
  ownerSignupVerify,
  ownerForgotPassword,
  ownerVerifyOtp,
  ownerResetPassword,
  ownerResendOtp,
}

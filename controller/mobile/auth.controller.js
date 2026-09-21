const User = require('../../models/User.model')
const Seat = require('../../models/Seat.model')
const Company = require('../../models/Company.model')
const Transaction = require('../../models/Transaction.model')
const AdminConfig = require('../../models/AdminConfig.model')
const createLog = require('../../models/Logs.model')
const dbConnect = require('../../utils/dbConnect')
const { isValidEmail, isTempEmail, enc, queueMail, isValidPassword, dec, now } = require('../../utils/utilities')
const Otp = require('../../models/Otp.model')
const mongoose = require('mongoose')
const crypto = require('crypto')

// Helper function to normalize seat enterpriseId field
const normalizeSeatEnterpriseId = async (seatId, enterpriseId) => {
  if (!seatId) return null

  try {
    const seat = await Seat.findById(seatId, 'enterpriseId enterprisedd enterprisxId companyId').lean()

    if (!seat) return null

    let needsUpdate = false
    const updateFields = {}

    let finalEnterpriseId = enterpriseId || seat.enterpriseId

    if (enterpriseId && enterpriseId !== seat.enterpriseId) {
      finalEnterpriseId = enterpriseId
      needsUpdate = true
    }

    if (!finalEnterpriseId || finalEnterpriseId === '' || finalEnterpriseId === null) {
      if (seat.enterprisxId) {
        finalEnterpriseId = seat.enterprisxId
        needsUpdate = true
      } else if (seat.enterprisedd) {
        finalEnterpriseId = seat.enterprisedd
        needsUpdate = true
      }
    }

    if ((!finalEnterpriseId || finalEnterpriseId === '') && seat.companyId) {
      const company = await Company.findById(seat.companyId, 'companyId').lean()
      if (company && company.companyId) {
        finalEnterpriseId = company.companyId
        needsUpdate = true
      }
    }

    if (needsUpdate) {
      updateFields.enterpriseId = finalEnterpriseId
      updateFields.enterprisedd = null
      updateFields.enterprisxId = null

      await Seat.updateOne({ _id: seatId }, updateFields)
      console.log(`✅ Fixed enterpriseId for seat ${seatId}:`, updateFields)
    }

    return finalEnterpriseId || seat.enterpriseId
  } catch (error) {
    console.error('❌ Error normalizing seat enterpriseId:', error.message)
    return null
  }
}

const signup = async (req, res) => {
  try {
    const { fname, lname, email, password, otp, license, enterpriseId, imei, deviceName } = req.body

    // Basic validations
    if (!fname) return res.status(400).json({ msg: 'Please enter first name' })
    if (!lname) return res.status(400).json({ msg: 'Please enter Last name' })
    if (!email) return res.status(400).json({ msg: 'Please enter email' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Please enter valid email' })
    if (isTempEmail(email)) return res.status(400).json({ msg: 'Temporary email addresses are not allowed. Please use a permanent email.' })
    if (!password) return res.status(400).json({ msg: 'Please enter password' })
    if (isValidPassword(password) !== true) return res.status(400).json({ msg: isValidPassword(password) })
    if (!otp) return res.status(400).json({ msg: 'Something went wrong' })

    // Device validations
    if (!imei) return res.status(400).json({ msg: 'Cannot get device details' })
    if (!deviceName) return res.status(400).json({ msg: 'Cannot get device details' })

    // License and Enterprise ID validations
    if (!license || !license.trim()) return res.status(400).json({ msg: 'License ID is required' })
    if (!enterpriseId || !enterpriseId.trim()) return res.status(400).json({ msg: 'Enterprise ID is required' })

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()
    // CASE-SENSITIVE - Do NOT convert to lowercase
    const cleanLicense = license.trim()
    const cleanEnterpriseId = enterpriseId.trim()

    // Check if user already exists across ANY company
    const existingUser = await User.findOne({ email: cleanEmail }, '_id signupType enterpriseId').lean()

    if (existingUser) {
      if (existingUser.signupType == '2') {
        return res.status(400).json({
          msg: 'Invalid signup method, Use google login',
          code: 'INVALID_SIGNUP_TYPE',
        })
      }
      return res.status(400).json({
        msg: 'User already registered. Please login to join another company.',
        code: 'USER_ALREADY_REGISTERED',
      })
    }

    // Find company by enterpriseId (CASE-SENSITIVE)
    const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id companyId').lean()
    if (!company) {
      return res.status(400).json({
        msg: 'Invalid Enterprise ID. Company not found.',
        code: 'INVALID_ENTERPRISE',
      })
    }

    // Find seat by EXACT license match (CASE-SENSITIVE)
    const seatWithLicense = await Seat.findOne(
      {
        license: cleanLicense, // EXACT match, case-sensitive
        companyId: company._id,
      },
      '_id email fname lname status enterpriseId enterprisedd enterprisxId companyId imei device activatedAt',
    ).lean()

    if (!seatWithLicense) {
      return res.status(400).json({
        msg: 'Invalid License ID. License not found for this company.',
        code: 'INVALID_LICENSE',
      })
    }

    // STRICT EMAIL VALIDATION - Email must match the invited email
    if (seatWithLicense.email.toLowerCase() !== cleanEmail) {
      return res.status(400).json({
        msg: 'This license is assigned to a different email address.',
        code: 'EMAIL_MISMATCH',
      })
    }

    // Verify enterpriseId matches (CASE-SENSITIVE)
    const seatEnterpriseId = seatWithLicense.enterpriseId || seatWithLicense.enterprisxId || seatWithLicense.enterprisedd || ''
    if (seatEnterpriseId && seatEnterpriseId !== cleanEnterpriseId) {
      return res.status(400).json({
        msg: 'Enterprise ID does not match the license.',
        code: 'ENTERPRISE_MISMATCH',
      })
    }

    // Fix status if it's "@"
    if (seatWithLicense.status === '@') {
      await Seat.updateOne({ _id: seatWithLicense._id }, { status: '0' })
      seatWithLicense.status = '0'
    }

    // Check license status
    if (seatWithLicense.status !== '0') {
      return res.status(400).json({
        msg: seatWithLicense.status === '1' ? 'License is already active.' : 'License is inactive.',
        code: 'LICENSE_USED',
      })
    }

    // Verify OTP
    const otpData = await Otp.findOne({ email: cleanEmail, otp, purpose: 1 }).lean()
    if (!otpData) return res.status(400).json({ msg: 'Invalid OTP' })
    if (otpData.otpExpiry < now()) return res.status(400).json({ msg: 'OTP expired' })

    // Check company license
    const companyData = await Company.findOne({ _id: seatWithLicense.companyId }, 'expiredAt plan currentPaymentId').lean()
    if (!companyData) return res.status(401).json({ msg: 'Invalid company' })

    const currentDate = now()
    const companyPlanExpired = companyData.expiredAt < currentDate
    if (companyPlanExpired) return res.status(403).json({ msg: 'Company plan expired' })

    // Check device mismatch
    if (seatWithLicense.imei != null && seatWithLicense.imei !== imei) {
      return res.status(403).json({ msg: 'Device mismatch' })
    }
    if (seatWithLicense.device != null && seatWithLicense.device !== deviceName) {
      return res.status(403).json({ msg: 'Device mismatch' })
    }

    // Create user with license and enterprise details
    const newUser = await User.create({
      fname: fname.trim(),
      lname: lname.trim(),
      email: cleanEmail,
      password: enc(password, process.env.PASSWORD_SECRET),
      signupType: '1',
      license: cleanLicense,
      enterpriseId: cleanEnterpriseId,
      companyIds: [company._id],
    })

    // Generate validation token (same as getUserInfo)
    const validationToken = crypto.randomBytes(6).toString('hex')
    const validationTokenExpiry = now() + 3600

    // Update Seat status to active with device info and validation token
    try {
      await Seat.updateOne(
        { _id: seatWithLicense._id },
        {
          status: '1',
          validationToken: validationToken, // Store validation token
          validationTokenExpiry: validationTokenExpiry,
          fname: fname.trim(),
          lname: lname.trim(),
          imei: imei,
          device: deviceName,
          activatedAt: currentDate,
          lastActive: currentDate,
          enterpriseId: cleanEnterpriseId,
          enterprisedd: null,
          enterprisxId: null,
        },
      )
      console.log('✅ Seat activated for license:', cleanLicense)
      createLog(seatWithLicense.companyId, `User activated`, cleanEmail)
    } catch (seatErr) {
      console.warn('⚠️ Failed to activate seat:', seatErr.message)
    }

    // Get payment info for response
    const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
      .sort({ createdAt: -1 })
      .lean()

    const companyInfo = await Company.findOne({ _id: company._id }, 'companyName').lean()

    const responseData = {
      status: true,
      msg: 'Registered successfully',
      data: {
        seatId: enc(seatWithLicense._id.toString(), process.env.ID_SECRET),
        userPlan: companyData.plan,
        email: cleanEmail,
        activatedAt: currentDate,
        expiredAt: companyData.expiredAt,
        planStartedAt: payment?.createdAt,
        companyName: companyInfo?.companyName || '',
        licenseId: cleanLicense,
        enterpriseId: cleanEnterpriseId,
        validationToken: validationToken, // Include validation token in response
      },
    }

    res.status(200).json(responseData)
  } catch (err) {
    console.log('❌ signup', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const sendOTP = async (req, res) => {
  try {
    const { email, name, purpose, license, enterpriseId } = req.body
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Please enter valid email' })
    if (isTempEmail(email)) return res.status(400).json({ msg: 'Temporary email addresses are not allowed. Please use a permanent email.' })
    if (!name) return res.status(400).json({ msg: 'Name is required' })
    if (!purpose) return res.status(400).json({ msg: 'purpose is required' })

    // Validate license and enterpriseId for signup flow
    if (purpose == 1) {
      if (!license || !license.trim()) return res.status(400).json({ msg: 'License ID is required' })
      if (!enterpriseId || !enterpriseId.trim()) return res.status(400).json({ msg: 'Enterprise ID is required' })
    }

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()
    // CASE-SENSITIVE - Do NOT convert to lowercase
    const cleanLicense = license ? license.trim() : null
    const cleanEnterpriseId = enterpriseId ? enterpriseId.trim() : null

    // Check if user already registered
    const isUserAlreadyExist = await User.findOne({ email: cleanEmail }, '_id').lean()
    if (isUserAlreadyExist) {
      return res.status(400).json({
        msg: 'User already registered. Please login to join another company.',
        code: 'USER_ALREADY_REGISTERED',
      })
    }

    // For signup with license, validate STRICTLY - NO AUTO-CREATION
    if (cleanLicense && cleanEnterpriseId) {
      // Find company by company code (CASE-SENSITIVE)
      const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id companyId').lean()
      if (!company) {
        return res.status(400).json({
          msg: 'Invalid Enterprise ID. Company not found.',
          code: 'INVALID_ENTERPRISE',
        })
      }

      console.log('🔍 Company found:', {
        id: company._id.toString(),
        companyId: company.companyId,
      })

      // Find seat by EXACT license match (CASE-SENSITIVE)
      const existingSeat = await Seat.findOne(
        {
          license: cleanLicense, // EXACT match
          companyId: company._id,
        },
        '_id email status enterpriseId enterprisedd enterprisxId companyId',
      ).lean()

      if (!existingSeat) {
        return res.status(400).json({
          msg: 'Invalid License ID. No invitation found with this license for this company.',
          code: 'INVALID_LICENSE',
        })
      }

      console.log('🔍 Seat found:', {
        id: existingSeat._id.toString(),
        email: existingSeat.email,
        status: existingSeat.status,
        enterpriseId: existingSeat.enterpriseId,
      })

      // STRICT EMAIL VALIDATION - Email must match the invited email
      if (existingSeat.email.toLowerCase() !== cleanEmail) {
        return res.status(400).json({
          msg: 'This license is assigned to a different email address.',
          code: 'EMAIL_MISMATCH',
        })
      }

      // Verify enterpriseId matches (CASE-SENSITIVE)
      const seatEnterpriseId = existingSeat.enterpriseId || existingSeat.enterprisxId || existingSeat.enterprisedd || ''
      if (seatEnterpriseId && seatEnterpriseId !== cleanEnterpriseId) {
        return res.status(400).json({
          msg: 'Enterprise ID does not match the license.',
          code: 'ENTERPRISE_MISMATCH',
        })
      }

      // Fix status if it's "@"
      if (existingSeat.status === '@') {
        await Seat.updateOne({ _id: existingSeat._id }, { status: '0' })
        existingSeat.status = '0'
      }

      // Check status
      if (existingSeat.status !== '0') {
        return res.status(400).json({
          msg: existingSeat.status === '1' ? 'License is already active.' : 'License is inactive.',
          code: 'LICENSE_USED',
        })
      }

      // Normalize enterpriseId field
      await normalizeSeatEnterpriseId(existingSeat._id, cleanEnterpriseId)
    }

    const otp = Math.floor(100000 + Math.random() * 900000)

    // Queue mail in background
    queueMail(cleanEmail, 'Email Verification OTP', 'otpforappuser', { otp, name: name || 'User' }).catch((err) => {
      console.log('❌ sendOTP: queueMail error', err.message)
    })

    // Save OTP to database
    await Otp.updateOne({ email: cleanEmail }, { email: cleanEmail, otp: otp, otpExpiry: now() + 300, purpose: purpose }, { upsert: true })

    res.status(200).json({ status: true, msg: 'OTP sent' })
  } catch (error) {
    console.log('❌ sendOTP', error.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const googleLogin = async (req, res) => {
  try {
    const { email, fname, lname, imei, deviceName, license, enterpriseId } = req.body

    // Basic validations
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
    if (isTempEmail(email)) return res.status(400).json({ msg: 'Temporary email addresses are not allowed. Please use a permanent email.' })
    if (!fname) return res.status(400).json({ msg: 'First name is required' })
    if (!imei) return res.status(400).json({ msg: 'Cannot get device details' })
    if (!deviceName) return res.status(400).json({ msg: 'Cannot get device details' })

    const cleanEmail = email.trim().toLowerCase()
    const cleanFname = fname.trim()
    const cleanLname = lname && lname.trim() ? lname.trim() : null

    await dbConnect()

    // Check if user exists in User model
    let user = await User.findOne({ email: cleanEmail }, '_id fname lname signupType').lean()

    if (user) {
      if (user.signupType === '1') {
        return res.status(400).json({ msg: 'Incorrect auth method. Please use email/password login.' })
      }
    }

    // If license and enterpriseId are provided, validate them STRICTLY
    if (license && enterpriseId) {
      // CASE-SENSITIVE - Do NOT convert to lowercase
      const cleanLicense = license.trim()
      const cleanEnterpriseId = enterpriseId.trim()

      console.log('🔍 Google Login - Validating credentials:', {
        email: cleanEmail,
        license: cleanLicense,
        enterpriseId: cleanEnterpriseId,
      })

      // Find company by enterpriseId (CASE-SENSITIVE)
      const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id companyId').lean()
      if (!company) {
        return res.status(400).json({
          msg: 'Invalid Enterprise ID. Company not found.',
          code: 'INVALID_ENTERPRISE',
        })
      }

      console.log('🔍 Company found:', {
        companyId: company._id.toString(),
        companyCode: company.companyId,
      })

      // Find seat by EXACT license match (CASE-SENSITIVE)
      let seat = await Seat.findOne(
        {
          license: cleanLicense, // EXACT match, case-sensitive
          companyId: company._id,
        },
        '_id email fname lname status enterpriseId enterprisedd enterprisxId companyId imei device activatedAt license',
      ).lean()

      if (!seat) {
        console.log('❌ Seat not found for license:', cleanLicense)
        return res.status(400).json({
          msg: 'Invalid License ID. No invitation found with this license for this company.',
          code: 'INVALID_LICENSE',
        })
      }

      console.log('🔍 Seat found:', {
        seatId: seat._id.toString(),
        seatEmail: seat.email,
        seatStatus: seat.status,
        seatEnterpriseId: seat.enterpriseId,
      })

      // STRICT EMAIL VALIDATION - Email MUST match the invited email
      if (seat.email.toLowerCase() !== cleanEmail) {
        console.log('❌ Email mismatch:', {
          providedEmail: cleanEmail,
          seatEmail: seat.email.toLowerCase(),
        })
        return res.status(400).json({
          msg: 'This license is assigned to a different email address.',
          code: 'EMAIL_MISMATCH',
        })
      }

      // Verify enterpriseId matches (CASE-SENSITIVE)
      const seatEnterpriseId = seat.enterpriseId || seat.enterprisxId || seat.enterprisedd || ''
      if (seatEnterpriseId && seatEnterpriseId !== cleanEnterpriseId) {
        console.log('❌ Enterprise ID mismatch:', {
          providedEnterpriseId: cleanEnterpriseId,
          seatEnterpriseId: seatEnterpriseId,
        })
        return res.status(400).json({
          msg: 'Enterprise ID does not match the license.',
          code: 'ENTERPRISE_MISMATCH',
        })
      }

      // Check license status
      if (seat.status !== '0' && seat.status !== '1') {
        return res.status(400).json({
          msg: seat.status === '2' ? 'User has left the company.' : seat.status === '3' ? 'User is deactivated.' : 'License is inactive.',
          code: 'LICENSE_INACTIVE',
        })
      }

      // Check company license expiry
      const companyData = await Company.findOne({ _id: seat.companyId }, 'expiredAt plan currentPaymentId').lean()
      if (!companyData) return res.status(401).json({ msg: 'Invalid company' })

      const currentDate = now()
      const companyPlanExpired = companyData.expiredAt < currentDate
      if (companyPlanExpired) return res.status(403).json({ msg: 'Company plan expired' })

      // Check device mismatch
      if (seat.imei != null && seat.imei !== imei) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }
      if (seat.device != null && seat.device !== deviceName) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }

      // Create user if doesn't exist
      if (!user) {
        user = await User.create({
          fname: cleanFname,
          lname: cleanLname,
          email: cleanEmail,
          signupType: '2',
          license: cleanLicense,
          enterpriseId: cleanEnterpriseId,
          companyIds: [company._id],
        })
        console.log('✅ Created new Google user:', cleanEmail)
      } else {
        // Update existing user with license info
        await User.updateOne(
          { _id: user._id },
          {
            $addToSet: { companyIds: company._id },
            $set: {
              license: cleanLicense,
              enterpriseId: cleanEnterpriseId,
            },
          },
        )
        console.log('✅ Updated existing Google user:', cleanEmail)
      }

      // Generate validation token (same as getUserInfo)
      const validationToken = crypto.randomBytes(6).toString('hex')
      const validationTokenExpiry = now() + 3600

      // Update seat status and device info with validation token
      const updateData = {
        imei: imei,
        device: deviceName,
        lastActive: currentDate,
        status: '1',
        enterpriseId: cleanEnterpriseId,
        enterprisedd: null,
        enterprisxId: null,
        validationToken: validationToken, // Store validation token
        validationTokenExpiry: validationTokenExpiry,
      }

      // If first time activation, set activatedAt
      if (seat.status === '0') {
        updateData.activatedAt = currentDate
        createLog(seat.companyId, `User activated via Google`, cleanEmail)
        console.log('✅ First time activation for:', cleanEmail)
      } else {
        createLog(seat.companyId, `${cleanEmail} logged in via Google`)
        console.log('✅ Returning user login:', cleanEmail)
      }

      await Seat.updateOne({ _id: seat._id }, updateData)

      // Get payment info
      const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
        .sort({ createdAt: -1 })
        .lean()

      const companyInfo = await Company.findOne({ _id: seat.companyId }, 'companyName').lean()

      // Return complete response with seat info including validation token
      return res.status(200).json({
        status: true,
        msg: 'Login successfully',
        data: {
          email: cleanEmail,
          fname: user.fname || cleanFname,
          lname: user.lname || cleanLname,
          seatId: enc(seat._id.toString(), process.env.ID_SECRET),
          userPlan: companyData.plan,
          activatedAt: seat.activatedAt || currentDate,
          expiredAt: companyData.expiredAt,
          planStartedAt: payment?.createdAt,
          companyName: companyInfo?.companyName || '',
          licenseId: cleanLicense,
          enterpriseId: cleanEnterpriseId,
          validationToken: validationToken, // Include validation token in response
        },
      })
    }

    // If no license provided, check if user has any active seats with matching email
    const activeSeat = await Seat.findOne(
      {
        email: cleanEmail,
        status: { $in: ['0', '1'] },
      },
      '_id companyId imei device status activatedAt enterpriseId license',
    ).lean()

    if (activeSeat) {
      // Normalize enterpriseId
      await normalizeSeatEnterpriseId(activeSeat._id, null)

      // Get company info
      const companyData = await Company.findOne({ _id: activeSeat.companyId }, 'expiredAt plan currentPaymentId companyId').lean()

      if (companyData) {
        const currentDate = now()
        const companyPlanExpired = companyData.expiredAt < currentDate

        if (!companyPlanExpired) {
          // Check device mismatch
          if (activeSeat.imei != null && activeSeat.imei !== imei) {
            return res.status(403).json({
              msg: 'This email address is already registered on another device. Please sign in from the registered device.',
            })
          }
          if (activeSeat.device != null && activeSeat.device !== deviceName) {
            return res.status(403).json({
              msg: 'This email address is already registered on another device. Please sign in from the registered device.',
            })
          }

          // Create user if doesn't exist
          if (!user) {
            user = await User.create({
              fname: cleanFname,
              lname: cleanLname,
              email: cleanEmail,
              signupType: '2',
              license: activeSeat.license,
              enterpriseId: activeSeat.enterpriseId || companyData.companyId,
              companyIds: [activeSeat.companyId],
            })
          }

          // Generate validation token (same as getUserInfo)
          const validationToken = crypto.randomBytes(6).toString('hex')
          const validationTokenExpiry = now() + 3600

          // Update seat with validation token
          const updateData = {
            imei: imei,
            device: deviceName,
            lastActive: currentDate,
            status: '1',
            validationToken: validationToken, // Store validation token
            validationTokenExpiry: validationTokenExpiry,
          }

          if (activeSeat.status === '0') {
            updateData.activatedAt = currentDate
            createLog(activeSeat.companyId, `User activated via Google`, cleanEmail)
          } else {
            createLog(activeSeat.companyId, `${cleanEmail} logged in via Google`)
          }

          await Seat.updateOne({ _id: activeSeat._id }, updateData)

          // Get payment info
          const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
            .sort({ createdAt: -1 })
            .lean()

          // Get company name
          const companyInfo = await Company.findOne({ _id: activeSeat.companyId }, 'companyName').lean()

          // Refresh seat data
          const updatedSeat = await Seat.findById(activeSeat._id, 'enterpriseId license').lean()

          return res.status(200).json({
            status: true,
            msg: 'Login successfully',
            data: {
              email: cleanEmail,
              fname: user.fname || cleanFname,
              lname: user.lname || cleanLname,
              seatId: enc(activeSeat._id.toString(), process.env.ID_SECRET),
              userPlan: companyData.plan,
              activatedAt: activeSeat.activatedAt || currentDate,
              expiredAt: companyData.expiredAt,
              planStartedAt: payment?.createdAt,
              companyName: companyInfo?.companyName || '',
              licenseId: updatedSeat?.license || activeSeat.license || '',
              enterpriseId: updatedSeat?.enterpriseId || activeSeat.enterpriseId || companyData.companyId || '',
              validationToken: validationToken, // Include validation token in response
            },
          })
        }
      }
    }

    // No active seat found - user needs to provide license and enterpriseId
    if (!user) {
      // Create user without company association
      user = await User.create({
        fname: cleanFname,
        lname: cleanLname,
        email: cleanEmail,
        signupType: '2',
      })
    }

    // Return response indicating license is required
    return res.status(200).json({
      status: true,
      msg: 'No active seat found. Please provide License ID and Enterprise ID.',
      data: {
        email: cleanEmail,
        fname: user.fname || cleanFname,
        lname: user.lname || cleanLname,
        requiresLicense: true,
      },
    })
  } catch (err) {
    console.log('❌ googleLogin in app', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const appleLogin = async (req, res) => {
  try {
    const { email, fname, lname, imei, deviceName, license, enterpriseId, appleId } = req.body

    // Basic validations
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
    if (isTempEmail(email)) return res.status(400).json({ msg: 'Temporary email addresses are not allowed. Please use a permanent email.' })
    if (!fname) return res.status(400).json({ msg: 'First name is required' })
    if (!imei) return res.status(400).json({ msg: 'Cannot get device details' })
    if (!deviceName) return res.status(400).json({ msg: 'Cannot get device details' })

    const cleanEmail = email.trim().toLowerCase()
    const cleanFname = fname.trim()
    const cleanLname = lname && lname.trim() ? lname.trim() : null

    await dbConnect()

    // Check if user exists in User model
    let user = await User.findOne({ email: cleanEmail }, '_id fname lname signupType').lean()

    if (user) {
      if (user.signupType === '1') {
        return res.status(400).json({ msg: 'Incorrect auth method. Please use email/password login.' })
      }
    }

    // If license and enterpriseId are provided, validate them STRICTLY
    if (license && enterpriseId) {
      // CASE-SENSITIVE - Do NOT convert to lowercase
      const cleanLicense = license.trim()
      const cleanEnterpriseId = enterpriseId.trim()

      // Find company by enterpriseId (CASE-SENSITIVE)
      const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id companyId').lean()
      if (!company) {
        return res.status(400).json({
          msg: 'Invalid Enterprise ID. Company not found.',
          code: 'INVALID_ENTERPRISE',
        })
      }

      // Find seat by EXACT license match (CASE-SENSITIVE)
      let seat = await Seat.findOne(
        {
          license: cleanLicense,
          companyId: company._id,
        },
        '_id email fname lname status enterpriseId enterprisedd enterprisxId companyId imei device activatedAt license',
      ).lean()

      if (!seat) {
        return res.status(400).json({
          msg: 'Invalid License ID. No invitation found with this license for this company.',
          code: 'INVALID_LICENSE',
        })
      }

      // STRICT EMAIL VALIDATION - Email MUST match the invited email
      if (seat.email.toLowerCase() !== cleanEmail) {
        return res.status(400).json({
          msg: 'This license is assigned to a different email address.',
          code: 'EMAIL_MISMATCH',
        })
      }

      // Verify enterpriseId matches (CASE-SENSITIVE)
      const seatEnterpriseId = seat.enterpriseId || seat.enterprisxId || seat.enterprisedd || ''
      if (seatEnterpriseId && seatEnterpriseId !== cleanEnterpriseId) {
        return res.status(400).json({
          msg: 'Enterprise ID does not match the license.',
          code: 'ENTERPRISE_MISMATCH',
        })
      }

      // Check license status
      if (seat.status !== '0' && seat.status !== '1') {
        return res.status(400).json({
          msg: seat.status === '2' ? 'User has left the company.' : seat.status === '3' ? 'User is deactivated.' : 'License is inactive.',
          code: 'LICENSE_INACTIVE',
        })
      }

      // Check company license expiry
      const companyData = await Company.findOne({ _id: seat.companyId }, 'expiredAt plan currentPaymentId').lean()
      if (!companyData) return res.status(401).json({ msg: 'Invalid company' })

      const currentDate = now()
      const companyPlanExpired = companyData.expiredAt < currentDate
      if (companyPlanExpired) return res.status(403).json({ msg: 'Company plan expired' })

      // Check device mismatch
      if (seat.imei != null && seat.imei !== imei) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }
      if (seat.device != null && seat.device !== deviceName) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }

      // Create user if doesn't exist
      if (!user) {
        user = await User.create({
          fname: cleanFname,
          lname: cleanLname,
          email: cleanEmail,
          signupType: '3',
          license: cleanLicense,
          enterpriseId: cleanEnterpriseId,
          appleId: appleId || null,
          companyIds: [company._id],
        })
      } else {
        // Update existing user with license info and appleId
        await User.updateOne(
          { _id: user._id },
          {
            $addToSet: { companyIds: company._id },
            $set: {
              license: cleanLicense,
              enterpriseId: cleanEnterpriseId,
              appleId: appleId || null,
            },
          },
        )
      }

      // Generate validation token (same as getUserInfo)
      const validationToken = crypto.randomBytes(6).toString('hex')
      const validationTokenExpiry = now() + 3600

      // Update seat status and device info with validation token
      const updateData = {
        imei: imei,
        device: deviceName,
        lastActive: currentDate,
        status: '1',
        enterpriseId: cleanEnterpriseId,
        enterprisedd: null,
        enterprisxId: null,
        validationToken: validationToken, // Store validation token
        validationTokenExpiry: validationTokenExpiry,
      }

      // If first time activation, set activatedAt
      if (seat.status === '0') {
        updateData.activatedAt = currentDate
        createLog(seat.companyId, `User activated via Apple`, cleanEmail)
      } else {
        createLog(seat.companyId, `${cleanEmail} logged in via Apple`)
      }

      await Seat.updateOne({ _id: seat._id }, updateData)

      // Get payment info
      const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
        .sort({ createdAt: -1 })
        .lean()

      const companyInfo = await Company.findOne({ _id: seat.companyId }, 'companyName').lean()

      // Return complete response with seat info including validation token
      return res.status(200).json({
        status: true,
        msg: 'Login successfully',
        data: {
          email: cleanEmail,
          fname: user.fname || cleanFname,
          lname: user.lname || cleanLname,
          seatId: enc(seat._id.toString(), process.env.ID_SECRET),
          userPlan: companyData.plan,
          activatedAt: seat.activatedAt || currentDate,
          expiredAt: companyData.expiredAt,
          planStartedAt: payment?.createdAt,
          companyName: companyInfo?.companyName || '',
          licenseId: cleanLicense,
          enterpriseId: cleanEnterpriseId,
          validationToken: validationToken, // Include validation token in response
        },
      })
    }

    // If no license provided, check if user has any active seats with matching email
    const activeSeat = await Seat.findOne(
      {
        email: cleanEmail,
        status: { $in: ['0', '1'] },
      },
      '_id companyId imei device status activatedAt enterpriseId license',
    ).lean()

    if (activeSeat) {
      // Normalize enterpriseId
      await normalizeSeatEnterpriseId(activeSeat._id, null)

      // Get company info
      const companyData = await Company.findOne({ _id: activeSeat.companyId }, 'expiredAt plan currentPaymentId companyId').lean()

      if (companyData) {
        const currentDate = now()
        const companyPlanExpired = companyData.expiredAt < currentDate

        if (!companyPlanExpired) {
          // Check device mismatch
          if (activeSeat.imei != null && activeSeat.imei !== imei) {
            return res.status(403).json({
              msg: 'This email address is already registered on another device. Please sign in from the registered device.',
            })
          }
          if (activeSeat.device != null && activeSeat.device !== deviceName) {
            return res.status(403).json({
              msg: 'This email address is already registered on another device. Please sign in from the registered device.',
            })
          }

          // Create user if doesn't exist
          if (!user) {
            user = await User.create({
              fname: cleanFname,
              lname: cleanLname,
              email: cleanEmail,
              signupType: '3',
              license: activeSeat.license,
              enterpriseId: activeSeat.enterpriseId || companyData.companyId,
              appleId: appleId || null,
              companyIds: [activeSeat.companyId],
            })
          }

          // Generate validation token (same as getUserInfo)
          const validationToken = crypto.randomBytes(6).toString('hex')
          const validationTokenExpiry = now() + 3600

          // Update seat with validation token
          const updateData = {
            imei: imei,
            device: deviceName,
            lastActive: currentDate,
            status: '1',
            validationToken: validationToken, // Store validation token
            validationTokenExpiry: validationTokenExpiry,
          }

          if (activeSeat.status === '0') {
            updateData.activatedAt = currentDate
            createLog(activeSeat.companyId, `User activated via Apple`, cleanEmail)
          } else {
            createLog(activeSeat.companyId, `${cleanEmail} logged in via Apple`)
          }

          await Seat.updateOne({ _id: activeSeat._id }, updateData)

          // Get payment info
          const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
            .sort({ createdAt: -1 })
            .lean()

          // Get company name
          const companyInfo = await Company.findOne({ _id: activeSeat.companyId }, 'companyName').lean()

          // Refresh seat data
          const updatedSeat = await Seat.findById(activeSeat._id, 'enterpriseId license').lean()

          return res.status(200).json({
            status: true,
            msg: 'Login successfully',
            data: {
              email: cleanEmail,
              fname: user.fname || cleanFname,
              lname: user.lname || cleanLname,
              seatId: enc(activeSeat._id.toString(), process.env.ID_SECRET),
              userPlan: companyData.plan,
              activatedAt: activeSeat.activatedAt || currentDate,
              expiredAt: companyData.expiredAt,
              planStartedAt: payment?.createdAt,
              companyName: companyInfo?.companyName || '',
              licenseId: updatedSeat?.license || activeSeat.license || '',
              enterpriseId: updatedSeat?.enterpriseId || activeSeat.enterpriseId || companyData.companyId || '',
              validationToken: validationToken, // Include validation token in response
            },
          })
        }
      }
    }

    // No active seat found - user needs to provide license and enterpriseId
    if (!user) {
      // Create user without company association
      user = await User.create({
        fname: cleanFname,
        lname: cleanLname,
        email: cleanEmail,
        signupType: '3',
        appleId: appleId || null,
      })
    }

    // Return response indicating license is required
    return res.status(200).json({
      status: true,
      msg: 'No active seat found. Please provide License ID and Enterprise ID.',
      data: {
        email: cleanEmail,
        fname: user.fname || cleanFname,
        lname: user.lname || cleanLname,
        requiresLicense: true,
      },
    })
  } catch (err) {
    console.log('❌ appleLogin in app', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const resendOTP = async (req, res) => {
  try {
    const { email, purpose, name, license, enterpriseId } = req.body
    if (!email) return res.status(400).json({ msg: 'email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
    if (!purpose) return res.status(400).json({ msg: 'purpose is required' })

    // Validate license for signup flow
    if (purpose == 1) {
      if (!license || !license.trim()) return res.status(400).json({ msg: 'License ID is required' })
      if (!enterpriseId || !enterpriseId.trim()) return res.status(400).json({ msg: 'Enterprise ID is required' })
    }

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()
    // CASE-SENSITIVE - Do NOT convert to lowercase
    const cleanLicense = license ? license.trim() : null
    const cleanEnterpriseId = enterpriseId ? enterpriseId.trim() : null

    // For signup, validate license STRICTLY
    if (cleanLicense && cleanEnterpriseId) {
      // Find company (CASE-SENSITIVE)
      const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id').lean()
      if (!company) {
        return res.status(400).json({
          msg: 'Invalid Enterprise ID. Company not found.',
          code: 'INVALID_ENTERPRISE',
        })
      }

      // Find seat by EXACT license (CASE-SENSITIVE)
      const seatWithLicense = await Seat.findOne(
        {
          license: cleanLicense,
          companyId: company._id,
          status: '0', // Pending
        },
        '_id email enterpriseId enterprisedd enterprisxId',
      ).lean()

      if (!seatWithLicense) {
        return res.status(400).json({
          msg: 'Invalid License ID or license already activated.',
          code: 'INVALID_LICENSE',
        })
      }

      // STRICT EMAIL VALIDATION
      if (seatWithLicense.email.toLowerCase() !== cleanEmail) {
        return res.status(400).json({
          msg: 'This license is assigned to a different email address.',
          code: 'EMAIL_MISMATCH',
        })
      }

      // Verify enterpriseId matches (CASE-SENSITIVE)
      const seatEnterpriseId = seatWithLicense.enterpriseId || seatWithLicense.enterprisxId || seatWithLicense.enterprisedd || ''
      if (seatEnterpriseId && seatEnterpriseId !== cleanEnterpriseId) {
        return res.status(400).json({
          msg: 'Enterprise ID does not match the license.',
          code: 'ENTERPRISE_MISMATCH',
        })
      }

      // Normalize enterpriseId field
      await normalizeSeatEnterpriseId(seatWithLicense._id, cleanEnterpriseId)
    }

    const newOtp = Math.floor(100000 + Math.random() * 900000)
    await Otp.updateOne({ email: cleanEmail, purpose }, { otp: newOtp, otpExpiry: now() + 300 })

    // Queue mail in background
    queueMail(cleanEmail, 'Email Verification OTP', 'otpforappuser', { otp: newOtp, name: name || 'User' }).catch((err) => {
      console.log('❌ resendOTP: queueMail error', err.message)
    })

    res.status(200).json({ status: true, msg: 'OTP sent' })
  } catch (err) {
    console.log('❌ resendOTP', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const login = async (req, res) => {
  try {
    const { email, password, license, enterpriseId, imei, deviceName } = req.body
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
    if (!password) return res.status(400).json({ msg: 'Password is required' })
    if (!imei) return res.status(400).json({ msg: 'Cannot get device details' })
    if (!deviceName) return res.status(400).json({ msg: 'Cannot get device details' })

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    const user = await User.findOne({ email: cleanEmail }, '_id password fname lname license enterpriseId signupType').lean()
    if (!user) return res.status(400).json({ msg: `You're not registered yet, Please register to continue` })
    if (user.signupType == '2') return res.status(400).json({ msg: 'Invalid login method, Use google login' })

    console.log('🔵user password', { email: cleanEmail, password: dec(user?.password, process.env.PASSWORD_SECRET) })
    if (dec(user.password, process.env.PASSWORD_SECRET) !== password) return res.status(400).json({ msg: 'Wrong email or password' })

    // Find user's seat
    let seatData = null

    if (license && enterpriseId) {
      // CASE-SENSITIVE - Do NOT convert to lowercase
      const cleanLicense = license.trim()
      const cleanEnterpriseId = enterpriseId.trim()

      // Find company (CASE-SENSITIVE)
      const company = await Company.findOne({ companyId: cleanEnterpriseId }, '_id').lean()
      if (!company) {
        return res.status(400).json({
          msg: 'Invalid Enterprise ID. Company not found.',
          code: 'INVALID_ENTERPRISE',
        })
      }

      // Find seat by EXACT license (CASE-SENSITIVE)
      seatData = await Seat.findOne(
        {
          license: cleanLicense,
          companyId: company._id,
          status: { $in: ['0', '1'] },
        },
        '_id email companyId imei device status activatedAt enterpriseId',
      ).lean()

      if (!seatData) {
        return res.status(400).json({
          msg: 'Invalid License ID. License not found for this company.',
          code: 'INVALID_LICENSE',
        })
      }

      // STRICT EMAIL VALIDATION
      if (seatData.email.toLowerCase() !== cleanEmail) {
        return res.status(400).json({
          msg: 'This license is assigned to a different email address.',
          code: 'EMAIL_MISMATCH',
        })
      }

      // Verify user has this license stored (CASE-SENSITIVE)
      if (user.license !== cleanLicense || user.enterpriseId !== cleanEnterpriseId) {
        return res.status(400).json({
          msg: 'License or Enterprise ID does not match your account.',
          code: 'LICENSE_MISMATCH',
        })
      }

      // Normalize enterpriseId field
      await normalizeSeatEnterpriseId(seatData._id, cleanEnterpriseId)
    } else {
      // If no license provided, find user's seat by email
      seatData = await Seat.findOne(
        {
          email: cleanEmail,
          status: { $in: ['0', '1'] },
        },
        '_id email companyId imei device status activatedAt enterpriseId license',
      ).lean()
    }

    // Check device mismatch and process login
    if (seatData) {
      if (seatData.imei != null && seatData.imei !== imei) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }
      if (seatData.device != null && seatData.device !== deviceName) {
        return res.status(403).json({
          msg: 'This email address is already registered on another device. Please sign in from the registered device.',
        })
      }

      // Get company info
      const companyData = await Company.findOne({ _id: seatData.companyId }, 'expiredAt plan currentPaymentId companyName').lean()

      if (companyData) {
        const currentDate = now()
        const companyPlanExpired = companyData.expiredAt < currentDate

        if (!companyPlanExpired) {
          // Update seat with device info and last active
          const updateData = {
            imei: imei,
            device: deviceName,
            lastActive: currentDate,
            status: '1',
          }

          if (seatData.status === '0') {
            updateData.activatedAt = currentDate
            createLog(seatData.companyId, `User activated`, cleanEmail)
          } else {
            createLog(seatData.companyId, `${cleanEmail} logged in`)
          }

          await Seat.updateOne({ _id: seatData._id }, updateData)

          // Get payment info
          const payment = await Transaction.findOne({ paymentId: companyData.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
            .sort({ createdAt: -1 })
            .lean()

          // Get updated seat for enterpriseId
          const updatedSeat = await Seat.findById(seatData._id, 'enterpriseId license').lean()

          return res.status(200).json({
            status: true,
            msg: 'Login successfully',
            data: {
              email: cleanEmail,
              fname: user.fname,
              lname: user.lname,
              seatId: enc(seatData._id.toString(), process.env.ID_SECRET),
              userPlan: companyData.plan,
              activatedAt: seatData.activatedAt || currentDate,
              expiredAt: companyData.expiredAt,
              planStartedAt: payment?.createdAt,
              companyName: companyData.companyName || '',
              licenseId: updatedSeat?.license || seatData.license || '',
              enterpriseId: updatedSeat?.enterpriseId || seatData.enterpriseId || '',
            },
          })
        } else {
          return res.status(403).json({ msg: 'Company plan expired' })
        }
      }
    }

    // Return basic login response if no seat data found
    res.status(200).json({
      status: true,
      msg: 'Login successfully',
      data: {
        email: cleanEmail,
        fname: user.fname,
        lname: user.lname,
        requiresLicense: true,
      },
    })
  } catch (err) {
    console.log('❌ login', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

// const login = async (req, res) => {
//   try {
//     const { email, password } = req.body

//     if (!email) return res.status(400).json({ msg: 'Email is required' })
//     if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
//     if (!password) return res.status(400).json({ msg: 'Password is required' })

//     await dbConnect()

//     // 🔐 Find global user
//     const user = await User.findOne({ email: email.trim().toLowerCase() }, '_id password fname lname signupType').lean()

//     if (!user) {
//       return res.status(400).json({ msg: `You're not registered yet, please register to continue` })
//     }

//     if (user.signupType === '2') {
//       return res.status(400).json({ msg: 'Invalid login method, use Google login' })
//     }

//     // 🔐 Password verification
//     if (dec(user.password, process.env.PASSWORD_SECRET) !== password) {
//       return res.status(400).json({ msg: 'Wrong email or password' })
//     }

//     // 🎫 Fetch all active seats for this user
//     const seats = await Seat.find(
//       {
//         email: email.trim().toLowerCase(),
//         status: { $in: ['0', '1'] }, // Pending or Active
//       },
//       '_id companyId status activatedAt',
//     ).lean()

//     // 🏢 If user has no company access yet
//     if (!seats.length) {
//       return res.status(200).json({
//         status: true,
//         msg: 'Login successfully',
//         data: {
//           email,
//           fname: user.fname,
//           lname: user.lname,
//           companies: [],
//         },
//       })
//     }

//     // 🏢 Build company list (multi-tenant ready)
//     const companyIds = seats.map((s) => s.companyId)
//     const companies = await Company.find({ _id: { $in: companyIds } }, '_id companyName plan expiredAt').lean()

//     const companyMap = new Map(companies.map((c) => [c._id.toString(), c]))

//     const companyAccess = seats.map((seat) => ({
//       seatId: enc(seat._id.toString(), process.env.ID_SECRET),
//       companyId: seat.companyId,
//       companyName: companyMap.get(seat.companyId.toString())?.companyName,
//       status: seat.status,
//       activatedAt: seat.activatedAt,
//       expiredAt: companyMap.get(seat.companyId.toString())?.expiredAt,
//       plan: companyMap.get(seat.companyId.toString())?.plan,
//     }))

//     return res.status(200).json({
//       status: true,
//       msg: 'Login successfully',
//       data: {
//         email,
//         fname: user.fname,
//         lname: user.lname,
//         companies: companyAccess, // 👈 frontend can show company selector
//       },
//     })
//   } catch (err) {
//     console.log('❌ login', err)
//     res.status(500).json({ msg: 'Something went wrong' })
//   }
// }

const userEntry = async (req, res) => {
  try {
    const { _id, imei, deviceName } = req.body
    if (!_id) return res.status(400).json({ msg: 'User id is required' })
    if (!imei) return res.status(400).json({ msg: 'Cannot get device details' })
    if (!deviceName) return res.status(400).json({ msg: 'Cannot get device details' })

    const seatId = dec(_id, process.env.ID_SECRET)

    await dbConnect()

    const seat = await Seat.findOne(
      { _id: seatId },
      'email imei device status activatedAt companyId enterpriseId enterprisedd enterprisxId license',
    ).lean()

    if (!seat) return res.status(401).json({ msg: 'Invalid user' })

    if (seat.status == '2' || seat.status == '3') {
      return res.status(200).json({
        status: true,
        msg: seat.status == '2' ? 'User is Left' : 'User is Deactivated',
        data: [],
      })
    }

    if (seat.imei != null && seat.imei !== imei) {
      return res.status(403).json({
        msg: 'This email address is already registered on another device. Please sign in from the registered device.',
      })
    }
    if (seat.device != null && seat.device !== deviceName) {
      return res.status(403).json({
        msg: 'This email address is already registered on another device. Please sign in from the registered device.',
      })
    }

    const hisCompany = await Company.findOne({ _id: seat.companyId }, '_id expiredAt plan currentPaymentId companyId').lean()
    if (!hisCompany) return res.status(401).json({ msg: 'Invalid credentials' })

    const currentDate = now()
    const companyPlanExpired = hisCompany.expiredAt < currentDate
    if (companyPlanExpired) return res.status(403).json({ msg: 'Company plan expired' })

    // Normalize enterpriseId
    let finalEnterpriseId = seat.enterpriseId

    if (!finalEnterpriseId || finalEnterpriseId === '') {
      if (seat.enterprisxId) {
        finalEnterpriseId = seat.enterprisxId
      } else if (seat.enterprisedd) {
        finalEnterpriseId = seat.enterprisedd
      } else if (hisCompany.companyId) {
        finalEnterpriseId = hisCompany.companyId
      }
    }

    // Generate validation token (same as getUserInfo)
    const validationToken = crypto.randomBytes(6).toString('hex')
    const validationTokenExpiry = now() + 3600

    // Update seat with validation token
    const updateData = {
      imei,
      device: deviceName,
      lastActive: currentDate,
      enterpriseId: finalEnterpriseId,
      enterprisedd: null,
      enterprisxId: null,
      validationToken: validationToken, // Store validation token
      validationTokenExpiry: validationTokenExpiry,
    }

    if (seat.status == 0) {
      updateData.status = '1'
      updateData.activatedAt = currentDate
      await Seat.updateOne({ _id: seat._id }, updateData)
      createLog(hisCompany._id, `User activated`, seat.email)
    } else {
      await Seat.updateOne({ _id: seat._id }, updateData)
      createLog(hisCompany._id, `${seat.email} logged in`)
    }

    // Update User model
    await User.updateOne(
      { email: seat.email },
      {
        $addToSet: { companyIds: hisCompany._id },
        $set: {
          enterpriseId: finalEnterpriseId,
          license: seat.license,
        },
      },
    )

    const payment = await Transaction.findOne({ paymentId: hisCompany.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
      .sort({ createdAt: -1 })
      .lean()

    const companyInfo = await Company.findOne({ _id: seat.companyId }, 'companyName').lean()

    res.status(200).json({
      status: true,
      msg: 'Login successfully',
      data: {
        seatId: enc(seat._id.toString(), process.env.ID_SECRET),
        userPlan: hisCompany.plan,
        email: seat.email,
        activatedAt: seat?.activatedAt || currentDate,
        expiredAt: hisCompany.expiredAt,
        planStartedAt: payment?.createdAt,
        companyName: companyInfo?.companyName || '',
        licenseId: seat.license || '',
        enterpriseId: finalEnterpriseId || '',
        validationToken: validationToken, // Include validation token in response
      },
    })
  } catch (err) {
    console.log('❌ userEntry err', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const deactivateMe = async (req, res) => {
  try {
    if (!req.user?.user) return res.status(401).json({ msg: 'Unauthorized' })

    await dbConnect()

    const user = await Seat.findById(req.user.user)
    if (!user) return res.status(401).json({ msg: 'Invalid user' })

    if (user.status !== '1') return res.status(403).json({ msg: 'You are already Left' })

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      await Seat.updateOne({ _id: user._id }, { status: '2', lastActive: now() }, { session })

      await Company.updateOne(
        { _id: user.companyId },
        {
          $inc: {
            usedSeat: -1,
            remainingSeat: 1,
            seatCapacity: 1,
            seatPurchased: -1,
          },
          $set: { updatedAt: now() },
        },
        { session },
      )

      await session.commitTransaction()

      createLog(user.companyId, 'User Left', user.email)

      res.status(200).json({ status: true, msg: 'User left successfully' })
    } catch (err) {
      await session.abortTransaction()
      throw err
    } finally {
      session.endSession()
    }
  } catch (err) {
    console.log('❌ deactivateMe', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getUserInfo = async (req, res) => {
  try {
    const { user } = req.user

    await dbConnect()
    const currentDate = now()
    const seat = await Seat.findOne({ _id: user }).lean()
    if (!seat) return res.status(401).json({ status: false, msg: 'Invalid user' })

    const company = await Company.findById(seat.companyId, '_id expiredAt plan').lean()
    if (!company) return res.status(401).json({ status: false, msg: 'Invalid Company' })

    // Normalize enterpriseId if needed
    await normalizeSeatEnterpriseId(seat._id, seat.enterpriseId)

    // Generate validation token
    const validationToken = crypto.randomBytes(6).toString('hex')
    const validationTokenExpiry = now() + 3600

    await Seat.updateOne({ _id: user }, { validationToken, validationTokenExpiry, lastActive: currentDate })

    const isPlanExpired = company.expiredAt < currentDate

    let statusReason = 'Active'
    if (seat.status == '2') statusReason = 'User is left'
    if (seat.status == '3') statusReason = 'User is deactivated'
    if (seat.status == '0' || seat.status == '1') {
      if (isPlanExpired) statusReason = 'Company plan expired'
    }

    const responseData = {
      Status: seat.status,
      planname: company.plan,
      planstatus: isPlanExpired ? 'Expired' : 'Active',
      statusReason: statusReason,
      validationToken: validationToken,
      expiredAt: company.expiredAt,
    }

    if (seat.status == '2') {
      return res.status(200).json({
        status: false,
        msg: 'User is left',
        data: responseData,
      })
    }
    if (seat.status == '3') {
      return res.status(200).json({
        status: false,
        msg: 'User is deactivated',
        data: responseData,
      })
    }

    if (isPlanExpired) {
      return res.status(403).json({
        status: false,
        msg: 'Company plan expired',
        data: responseData,
      })
    }

    res.status(200).json({
      status: true,
      data: responseData,
    })
  } catch (err) {
    console.log('❌ getUserInfo', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getConfigs = async (req, res) => {
  try {
    const { user, company } = req.user
    const metaKeys = req.body?.metaKeys

    if (!metaKeys || !metaKeys.length) return res.status(400).json({ msg: 'Meta keys are required' })

    await dbConnect()

    const seat = await Seat.findById(user, 'status').lean()
    if (!seat) return res.status(401).json({ msg: 'Invalid user' })

    await normalizeSeatEnterpriseId(seat._id, null)

    if (seat.status === '2' || seat.status === '3') {
      return res.status(200).json({
        status: true,
        msg: seat.status === '2' ? 'User is Left' : 'User is Deactivated',
        data: [],
      })
    }

    const companyData = await Company.findById(company, 'expiredAt').lean()
    if (!companyData) return res.status(401).json({ msg: 'Invalid company' })

    if (Number(companyData.expiredAt) < now()) {
      return res.status(403).json({
        status: true,
        msg: 'Company license expired',
        data: {},
      })
    }

    const settings = {}
    metaKeys.forEach((key) => {
      settings[key] = '0'
    })

    const data = await AdminConfig.find({ owner: company, metaKey: { $in: metaKeys } }, 'metaKey metaValue').lean()
    data.forEach((item) => {
      settings[item.metaKey] = item.metaValue
    })
    return res.status(200).json({ status: true, data: settings })
  } catch (err) {
    console.log('❌ getConfigs err', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getAvailableSeat = async (req, res) => {
  try {
    const { email } = req.query
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })

    const cleanEmail = email.trim().toLowerCase()

    await dbConnect()

    let users = await Seat.aggregate([
      {
        $match: {
          email: cleanEmail,
          status: { $in: ['0', '1'] },
        },
      },
      {
        $lookup: {
          from: 'companies',
          localField: 'companyId',
          foreignField: '_id',
          as: 'company',
        },
      },
      { $unwind: '$company' },
      {
        $project: {
          _id: 1,
          entId: '$company.companyId',
          license: 1,
          device: 1,
          imei: 1,
          plan: '$company.plan',
          userStatus: '$status',
          companyLogo: '$company.logo',
          companyName: '$company.companyName',
          expiredAt: '$company.expiredAt',
          isCompanyActive: { $gt: ['$company.expiredAt', now()] },
          createdAt: 1,
          updatedAt: 1,
        },
      },
      { $sort: { isCompanyActive: -1, userStatus: 1 } },
    ])

    // Normalize enterpriseId for each seat
    for (const user of users) {
      await normalizeSeatEnterpriseId(user._id, null)
    }

    users = users.map((item) => ({
      _id: enc(item._id.toString(), process.env.ID_SECRET),
      entId: item.entId,
      license: item.license,
      device: item.device,
      imei: item.imei,
      plan: item.plan,
      userStatus: item.userStatus,
      companyLogo: item.companyLogo ? process.env.FILE_SOURCE + 'logo/' + item.companyLogo : null,
      companyName: item.companyName,
      expiredAt: item.expiredAt,
      isCompanyActive: item.isCompanyActive,
      statusText: item.userStatus === '0' ? 'Inactive' : item.userStatus === '1' ? 'Active' : item.userStatus === '2' ? 'Left' : 'Deactivated',
      invitedAt: item.createdAt || item.updatedAt || null,
    }))

    if (!users.length) {
      return res.status(202).json({
        status: true,
        msg: 'No seats found for this email',
        data: [],
      })
    }

    const activeCompanySeats = users.filter((user) => user.isCompanyActive)
    if (!activeCompanySeats.length) {
      return res.status(200).json({
        status: true,
        msg: 'All company licenses have expired',
        data: [],
      })
    }

    res.status(200).json({
      status: true,
      data: activeCompanySeats,
    })
  } catch (err) {
    console.log('❌ getAvailableSeat err', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const userValidation = async (req, res) => {
  try {
    const { email, license, validationtoken } = req.body
    if (!email || !license || !validationtoken) return res.status(400).json({ status: false, msg: 'Missing required fields' })

    const cleanEmail = email.trim().toLowerCase()
    // CASE-SENSITIVE for license
    const cleanLicense = license.trim()

    await dbConnect()
    const seat = await Seat.findOne({ email: cleanEmail, license: cleanLicense }).lean()

    if (!seat) return res.status(200).json({ status: false, msg: 'User not found' })

    await normalizeSeatEnterpriseId(seat._id, seat.enterpriseId)

    if (seat.validationToken !== validationtoken) {
      return res.status(200).json({ status: false, msg: 'Invalid token' })
    }

    if (!seat.validationTokenExpiry || seat.validationTokenExpiry < now()) {
      return res.status(200).json({ status: false, msg: 'Token expired' })
    }

    return res.status(200).json({ status: true, msg: 'Token valid' })
  } catch (err) {
    console.log('❌ userValidation err', err.message)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

const checkGoogleUserExists = async (req, res) => {
  try {
    const { email } = req.body

    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })
    if (isTempEmail(email)) return res.status(400).json({ msg: 'Temporary email addresses are not allowed. Please use a permanent email.' })

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()

    const existingUser = await User.findOne({ email: cleanEmail }, '_id signupType').lean()

    const hasSeats = await Seat.findOne(
      {
        email: cleanEmail,
        status: { $in: ['0', '1'] },
      },
      '_id',
    ).lean()

    if (existingUser) {
      return res.status(200).json({
        status: true,
        data: {
          exists: true,
          signupType: existingUser.signupType,
          message: existingUser.signupType === '2' ? 'User exists with Google login' : 'User exists with email/password login',
          hasSeats: !!hasSeats,
        },
      })
    }

    if (hasSeats) {
      return res.status(200).json({
        status: true,
        data: {
          exists: false,
          hasPendingInvites: true,
          message: 'You have pending invitations. Please sign up to accept them.',
        },
      })
    }

    return res.status(200).json({
      status: true,
      data: {
        exists: false,
        hasPendingInvites: false,
        message: 'User not found. Please sign up to continue.',
      },
    })
  } catch (err) {
    console.log('❌ checkGoogleUserExists', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const checkAppleUserExists = async (req, res) => {
  try {
    const { appleId, imei, deviceName } = req.body

    if (!appleId) return res.status(400).json({ msg: 'Apple ID is required' })
    if (!imei) return res.status(400).json({ msg: 'IMEI is required' })
    if (!deviceName) return res.status(400).json({ msg: 'Device name is required' })

    await dbConnect()

    // Find user by appleId
    const existingUser = await User.findOne({ appleId: appleId }, 'email signupType appleId').lean()

    // Store device info
    try {
      await DeviceInfo.findOneAndUpdate(
        { appleId: appleId },
        {
          appleId: appleId,
          imei: imei,
          deviceName: deviceName,
          lastUsed: new Date(),
        },
        { upsert: true, new: true },
      )
    } catch (deviceErr) {
      console.log('⚠️ Error saving device info:', deviceErr.message)
      // Continue even if device info saving fails
    }

    if (existingUser) {
      // Check for seats using the user's email
      const hasSeats = await Seat.findOne(
        {
          email: existingUser.email,
          status: { $in: ['0', '1'] },
        },
        '_id',
      ).lean()

      return res.status(200).json({
        status: true,
        email: existingUser.email,
        data: {
          exists: true,
          email: existingUser.email,
          signupType: existingUser.signupType,
          appleId: existingUser.appleId,
          message: 'User exists with Apple login',
          hasSeats: !!hasSeats,
        },
      })
    }

    // If user doesn't exist, we can't check seats without email
    return res.status(200).json({
      status: true,
      email: null,
      data: {
        exists: false,
        email: null,
        appleId: appleId,
        hasPendingInvites: false,
        message: 'User not found. Please sign up to continue.',
      },
    })
  } catch (err) {
    console.log('❌ checkAppleUserExists', err.message)
    res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const changePassword = async (req, res) => {
  try {
    const { oldPassword, newPassword } = req.body
    const userId = req.user.user

    if (!oldPassword) return res.status(400).json({ msg: 'Old password is required' })
    if (!newPassword) return res.status(400).json({ msg: 'New password is required' })

    if (oldPassword === newPassword) {
      return res.status(400).json({ msg: 'New password cannot be same as old password' })
    }

    if (isValidPassword(newPassword) !== true) {
      return res.status(400).json({ msg: isValidPassword(newPassword) })
    }

    await dbConnect()

    const seat = await Seat.findById(userId, 'email').lean()
    if (!seat) return res.status(401).json({ msg: 'Unauthorized: User seat not found' })

    const user = await User.findOne({ email: seat.email })
    if (!user) return res.status(404).json({ msg: 'User account not found' })

    if (user.signupType === '2') {
      return res.status(400).json({ msg: 'Social login users cannot change password' })
    }

    if (dec(user.password, process.env.PASSWORD_SECRET) !== oldPassword) {
      return res.status(400).json({ msg: 'Old password is incorrect' })
    }

    user.password = enc(newPassword, process.env.PASSWORD_SECRET)
    await user.save()

    res.status(200).json({ status: true, msg: 'Password changed successfully' })
  } catch (err) {
    console.log('❌ changePassword', err.message)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const deleteUserByEmail = async (req, res) => {
  try {
    const { email } = req.body

    // ✅ Validation
    if (!email) {
      return res.status(400).json({ status: false, msg: 'Email is required' })
    }

    if (!isValidEmail(email)) {
      return res.status(400).json({ status: false, msg: 'Please enter a valid email' })
    }

    await dbConnect()

    const cleanEmail = email.trim().toLowerCase()
    console.log(`🗑️ Initiating account deletion for email: ${cleanEmail}`)

    // ✅ Step 1: Find user by email
    const user = await User.findOne({ email: cleanEmail }, '_id fname lname')
    if (!user) {
      return res.status(404).json({ status: false, msg: 'User account not found' })
    }

    console.log(`👤 Found user: ${user._id.toString()}`)

    // ✅ Step 2: Start transaction
    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Get all seats for this user
      const seatsToDelete = await Seat.find({ email: cleanEmail }).session(session)
      console.log(`🔍 Found ${seatsToDelete.length} seat(s) for email: ${cleanEmail}`)

      // ✅ IMPORTANT: Only return seat capacity for ACTIVE/PENDING seats
      // If seat was already deactivated/left (status 2 or 3), capacity was already returned
      const activeSeats = seatsToDelete.filter((s) => s.status === '0' || s.status === '1')
      const companyIdsToReturn = [...new Set(activeSeats.map((s) => s.companyId?.toString()).filter(Boolean))]

      console.log(`📊 Active/Pending seats to return capacity: ${activeSeats.length}`)
      console.log(`📊 Already deactivated seats (no capacity return): ${seatsToDelete.length - activeSeats.length}`)
      console.log(`📊 Unique companies to return capacity: ${companyIdsToReturn.length}`)

      // ✅ Delete all seats
      const deletedSeats = await Seat.deleteMany({ email: cleanEmail }, { session })
      console.log(`✅ Deleted ${deletedSeats.deletedCount} seat(s) from Seat table`)

      // ✅ Return seat capacity ONLY for active/pending seats
      if (companyIdsToReturn.length > 0) {
        for (const companyId of companyIdsToReturn) {
          try {
            await Company.updateOne(
              { _id: companyId },
              {
                $inc: {
                  usedSeat: -1,
                  remainingSeat: 1,
                  seatCapacity: 1, // Increase available seats back
                  seatPurchased: -1, // Decrease purchased seats
                },
                $set: { updatedAt: now() },
              },
              { session },
            )
            console.log(`✅ Returned seat capacity to company: ${companyId.toString()}`)
          } catch (capacityErr) {
            console.warn(`⚠️ Could not update capacity for company ${companyId}:`, capacityErr.message)
          }
        }
      }

      // Delete user from User table
      const deletedUser = await User.deleteOne({ _id: user._id }, { session })
      console.log(`✅ User deleted: ${user._id.toString()}`)

      // Delete OTP records
      const deletedOtps = await Otp.deleteMany({ email: cleanEmail }, { session })
      console.log(`✅ Deleted ${deletedOtps.deletedCount} OTP record(s)`)

      // Log deletion for each company - different message based on seat status
      if (seatsToDelete.length > 0) {
        for (const seat of seatsToDelete) {
          try {
            const wasCapacityReturned = seat.status === '0' || seat.status === '1'
            const logMessage = wasCapacityReturned
              ? 'User Account & Seat Deleted - Capacity Returned'
              : 'User Account & Seat Deleted - Capacity Already Returned (was deactivated)'
            await createLog(seat.companyId, logMessage, cleanEmail)
          } catch (logErr) {
            console.warn(`⚠️ Could not log deletion for company ${seat.companyId}:`, logErr.message)
          }
        }
      }

      // Commit transaction
      await session.commitTransaction()
      console.log(`✅ Transaction committed successfully`)

      // ✅ Step 3: Send confirmation email
      const deletionTime = Date.now()
      await queueMail(cleanEmail, 'Account Deletion Confirmation', 'userDelete', {
        userName: user.fname || 'User',
        email: cleanEmail,
        createdAt: new Date(deletionTime).toLocaleString(),
        supportEmail: 'ent-support@gpsmapcamera.com',
      }).catch((mailErr) => {
        console.warn('⚠️ Could not send deletion confirmation email:', mailErr.message)
      })

      console.log(`📧 Deletion confirmation email queued for: ${cleanEmail}`)

      return res.status(200).json({
        status: true,
        msg: 'Your account and seats have been successfully deleted. Seat capacity has been returned to administrators.',
        data: {
          email: cleanEmail,
          deletedAt: now(),
          seatsDeleted: deletedSeats.deletedCount,
          seatsWithCapacityReturned: activeSeats.length,
          seatsAlreadyDeactivated: seatsToDelete.length - activeSeats.length,
          companiesAffected: new Set(seatsToDelete.map((s) => s.companyId.toString())).size,
          capacityReturned: activeSeats.length,
          permanentlyRemoved: true,
        },
      })
    } catch (transactionErr) {
      await session.abortTransaction()
      console.error(`❌ Transaction failed: ${transactionErr.message}`)
      throw transactionErr
    } finally {
      await session.endSession()
    }
  } catch (err) {
    console.error(`❌ deleteUserByEmail Error:`, err.message)
    console.error(err.stack)
    res.status(500).json({ status: false, msg: 'Failed to delete account. Please try again later.' })
  }
}

module.exports = {
  login,
  deactivateMe,
  getUserInfo,
  getConfigs,
  getAvailableSeat,
  signup,
  userEntry,
  resendOTP,
  googleLogin,
  appleLogin,
  sendOTP,
  userValidation,
  checkGoogleUserExists,
  checkAppleUserExists,
  changePassword,
  deleteUserByEmail,
}

const ImageCode = require('../../models/ImageCode.model')
const Company = require('../../models/Company.model')
const Seat = require('../../models/Seat.model')
const dbConnect = require('../../utils/dbConnect')
const { now, enc } = require('../../utils/utilities')

/* -------------------------------------------------- */
/* RANDOM CODE GENERATOR */
/* -------------------------------------------------- */

const generateRandomCode = (length) => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ123456789'
  let result = ''

  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }

  return result
}

/* -------------------------------------------------- */
/* UNIQUE CODE GENERATOR (SMART LENGTH) */
/* -------------------------------------------------- */

const generateUniqueImageCode = async () => {
  let length = 10
  let attempts = 0
  let code = ''
  let isUnique = false

  while (!isUnique) {
    code = generateRandomCode(length)

    const existing = await ImageCode.findOne({ code })

    if (!existing) {
      isUnique = true
      break
    }

    attempts++

    // Increase length if collisions
    if (attempts >= 10) {
      length++
      attempts = 0
    }
  }

  return code
}

/* -------------------------------------------------- */
/* GENERATE IMAGE CODE */
/* -------------------------------------------------- */

const generateImageCode = async (req, res) => {
  try {
    await dbConnect()

    const { companyId: requestCompanyId } = req.body
    const seatId = req.user.user
    const tokenCompanyId = req.user.company

    // Determine which company ID to use
    let companyId = tokenCompanyId

    if (requestCompanyId) {
      // Validate that the requested company exists and is valid
      const requestedCompany = await Company.findById(requestCompanyId, '_id expiredAt').lean()

      if (!requestedCompany) {
        return res.status(400).json({ status: false, msg: 'Invalid company ID' })
      }

      // Check if company license is expired (only if expiredAt is set)
      if (requestedCompany?.expiredAt && Number(requestedCompany.expiredAt) < now()) {
        return res.status(400).json({ status: false, msg: 'Company license expired' })
      }

      // Verify this seat belongs to the requested company
      const seatInCompany = await Seat.findOne({
        _id: seatId,
        companyId: requestCompanyId,
      }).lean()

      if (seatInCompany) {
        companyId = requestCompanyId
      }
      // If seat doesn't belong to requested company, use token companyId
    }

    // Get seat details for binding
    const seat = await Seat.findById(seatId, 'license').lean()
    if (!seat) {
      return res.status(401).json({ status: false, msg: 'Invalid user session' })
    }

    // Check if there's an existing unused code for this seat and delete it to avoid duplicate key error
    const existingUnusedCode = await ImageCode.findOne({
      isUsed: false,
      seatId: seatId,
    }).lean()

    if (existingUnusedCode) {
      await ImageCode.deleteOne({ _id: existingUnusedCode._id })
      console.log(`🗑️ Deleted existing unused code ${existingUnusedCode.code} for seat ${seatId}`)
    }

    // Generate a brand new unique code - NEVER reuse existing codes
    const code = await generateUniqueImageCode()

    // Configurable expiry time (default 30 days)
    const expiryDays = process.env.IMAGE_CODE_EXPIRY_DAYS ? parseInt(process.env.IMAGE_CODE_EXPIRY_DAYS) : 30
    const expiresAt = Date.now() + expiryDays * 24 * 60 * 60 * 1000

    // Create new Image Code bound to this specific user session
    const imageCodeRecord = await ImageCode.create({
      code,
      isUsed: false,
      expiresAt,
      companyId: companyId,
      seatId: seatId,
      licenseEntryId: seatId,
      license: seat.license,
      invitationId: seatId,
    })

    res.status(200).json({
      status: true,
      msg: 'Code generated successfully',
      data: {
        code: imageCodeRecord.code,
        expiresAt: imageCodeRecord.expiresAt,
        createdAt: imageCodeRecord.createdAt,
        updatedAt: imageCodeRecord.updatedAt,
        isUsed: imageCodeRecord.isUsed,
        companyId: imageCodeRecord.companyId,
      },
    })
  } catch (err) {
    console.error('❌ generateImageCode error:', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

/* -------------------------------------------------- */
/* UPDATE IMAGE DETAILS */
/* -------------------------------------------------- */

const updateImageDetails = async (req, res) => {
  try {
    const { code, imageDetails, companyId: requestCompanyId } = req.body

    if (!code) {
      return res.status(400).json({ status: false, msg: 'Image code is required' })
    }

    await dbConnect()

    const seatId = req.user.user
    const tokenCompanyId = req.user.company

    // Use the company from the token as the primary source of truth
    const companyIdToUse = requestCompanyId || tokenCompanyId

    // Verify this seat belongs to this company
    const seatInCompany = await Seat.findOne({
      _id: seatId,
      companyId: companyIdToUse,
    }).lean()

    if (!seatInCompany) {
      return res.status(403).json({
        status: false,
        msg: 'You do not belong to this company',
      })
    }

    // ATOMIC UPDATE: Use findOneAndUpdate to prevent race conditions
    // Only update if: code exists, not expired, not used, belongs to correct company and seat
    const record = await ImageCode.findOneAndUpdate(
      {
        code: code,
        isUsed: false,
        expiresAt: { $gt: now() }, // Not expired
        companyId: companyIdToUse, // Must belong to current company
        seatId: seatId, // Must belong to current user session
      },
      {
        $set: {
          imageDetails: imageDetails || {},
          isUsed: true,
          capturedAt: now(),
          expiresAt: null, // Stop TTL delete for used codes
          updatedAt: Date.now(),
        },
      },
      { new: true },
    ).lean()

    if (!record) {
      // Check if code exists at all
      const existingCode = await ImageCode.findOne({ code }).lean()
      if (!existingCode) {
        return res.status(404).json({ status: false, msg: 'Invalid image code' })
      }
      // Check if already used
      if (existingCode.isUsed) {
        return res.status(400).json({ status: false, msg: 'This code has already been used' })
      }
      // Check if expired
      if (existingCode.expiresAt && existingCode.expiresAt < now()) {
        return res.status(400).json({ status: false, msg: 'Code expired' })
      }
      // Check company mismatch
      if (existingCode.companyId && existingCode.companyId.toString() !== companyIdToUse.toString()) {
        return res.status(403).json({
          status: false,
          msg: 'This GMC Photo Code belongs to a different company. Please switch to that company or generate a new code for the current company.',
        })
      }
      // Check seat mismatch (different user session)
      if (existingCode.seatId && existingCode.seatId.toString() !== seatId.toString()) {
        return res.status(403).json({
          status: false,
          msg: 'This GMC Photo Code belongs to a different user session.',
        })
      }
      // Fallback error
      return res.status(400).json({ status: false, msg: 'Failed to update image code' })
    }

    // Sync with DriveUpload if record exists
    const DriveUpload = require('../../models/DriveUpload.model')
    const uploadRecord = await DriveUpload.findOne({ imageCode: code })

    if (uploadRecord && imageDetails) {
      // Update DriveUpload record with all image details
      // Basic Info
      uploadRecord.photoCode = imageDetails.pc || uploadRecord.photoCode
      uploadRecord.enterpriseCode = imageDetails.ec || uploadRecord.enterpriseCode
      uploadRecord.firstName = imageDetails.fn || uploadRecord.firstName
      uploadRecord.lastName = imageDetails.ln || uploadRecord.lastName
      uploadRecord.email = imageDetails.em || uploadRecord.email

      // Device Info
      uploadRecord.appVersion = imageDetails.av || uploadRecord.appVersion
      uploadRecord.deviceName = imageDetails.dn || uploadRecord.deviceName
      uploadRecord.os = imageDetails.os || uploadRecord.os

      // Location Info
      uploadRecord.country = imageDetails.cty || uploadRecord.country
      uploadRecord.city = imageDetails.ct || uploadRecord.city
      uploadRecord.state = imageDetails.st || uploadRecord.state
      uploadRecord.address = imageDetails.addr || uploadRecord.address
      uploadRecord.plusCode = imageDetails.pcd || uploadRecord.plusCode

      // Parse latitude/longitude from ll field
      if (imageDetails.ll) {
        const [lat, lng] = imageDetails.ll.split(',').map((coord) => parseFloat(coord.trim()))
        uploadRecord.latitude = lat || uploadRecord.latitude
        uploadRecord.longitude = lng || uploadRecord.longitude
      }

      // Time Info
      uploadRecord.captureDate = imageDetails.cd || uploadRecord.captureDate
      uploadRecord.captureTime = imageDetails.tm || uploadRecord.captureTime
      uploadRecord.timezone = imageDetails.tz || uploadRecord.timezone

      // Camera Settings
      uploadRecord.ratio = imageDetails.rt || uploadRecord.ratio
      uploadRecord.mirror = imageDetails.mir || uploadRecord.mirror
      uploadRecord.cameraSide = imageDetails.cs || uploadRecord.cameraSide
      uploadRecord.stampOnPhoto = imageDetails.sop || uploadRecord.stampOnPhoto

      // Project Info
      uploadRecord.routeTag = imageDetails.rtag || uploadRecord.routeTag
      uploadRecord.mapType = imageDetails.mt || uploadRecord.mapType
      uploadRecord.projectName = imageDetails.pn || uploadRecord.projectName
      uploadRecord.companyName = imageDetails.cn || uploadRecord.companyName

      // Additional Info
      uploadRecord.number = imageDetails.num || uploadRecord.number
      uploadRecord.hashtag = imageDetails.nh || uploadRecord.hashtag
      uploadRecord.mobile = imageDetails.mob || uploadRecord.mobile

      // Weather Info
      uploadRecord.weatherTemp = imageDetails.wt || uploadRecord.weatherTemp
      uploadRecord.compass = imageDetails.cmp || uploadRecord.compass
      uploadRecord.mapFormat = imageDetails.mf || uploadRecord.mapFormat
      uploadRecord.wind = imageDetails.wnd || uploadRecord.wind
      uploadRecord.humidity = imageDetails.hum || uploadRecord.humidity
      uploadRecord.pressure = imageDetails.prs || uploadRecord.pressure
      uploadRecord.altitude = imageDetails.alt || uploadRecord.altitude
      uploadRecord.accuracy = imageDetails.acc || uploadRecord.accuracy
      uploadRecord.sound = imageDetails.snd || uploadRecord.sound
      uploadRecord.magneticField = imageDetails.mf || uploadRecord.magneticField
      uploadRecord.reportingTag = imageDetails.rtag || uploadRecord.reportingTag

      // Stamp Settings
      uploadRecord.stampPosition = imageDetails.stp || uploadRecord.stampPosition
      uploadRecord.fontSize = imageDetails.fs || uploadRecord.fontSize
      uploadRecord.stampPlacement = imageDetails.sp || uploadRecord.stampPlacement
      uploadRecord.mapPosition = imageDetails.mp || uploadRecord.mapPosition

      // Legacy fields
      uploadRecord.projectId = imageDetails.projectId || uploadRecord.projectId
      uploadRecord.capturedAt = imageDetails.timestamp || imageDetails.capturedAt || uploadRecord.capturedAt

      await uploadRecord.save()
    }

    res.status(200).json({
      status: true,
      msg: 'Image details updated successfully',
      data: {
        code: record.code,
        imageDetails: record.imageDetails,
        isUsed: record.isUsed,
        capturedAt: record.capturedAt,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    })
  } catch (err) {
    console.error('updateImageDetails error:', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

/* -------------------------------------------------- */
/* GET IMAGE DETAILS */
/* -------------------------------------------------- */

const getImageDetails = async (req, res) => {
  try {
    const { code } = req.query

    if (!code) {
      return res.status(400).json({ status: false, msg: 'Image code is required' })
    }

    await dbConnect()

    const record = await ImageCode.findOne({ code })

    if (!record) {
      return res.status(404).json({ status: false, msg: 'No matching record was found for the code you entered.' })
    }

    // Check if the code has been used and has image details
    if (!record.isUsed || !record.imageDetails || Object.keys(record.imageDetails).length === 0) {
      return res.status(404).json({
        status: false,
        msg: 'No image data available for this code. The code has been generated but not yet used.',
      })
    }

    // Check if code is expired (only if not used)
    if (!record.isUsed && record.expiresAt && record.expiresAt < Date.now()) {
      return res.status(400).json({ status: false, msg: 'Code has expired' })
    }

    // NEW: Verify user has access to this image code
    // If request is authenticated, verify the code belongs to the user's company
    if (req.user && req.user.company) {
      if (record.companyId && record.companyId.toString() !== req.user.company.toString()) {
        return res.status(403).json({
          status: false,
          msg: 'You do not have access to this image code.',
        })
      }
    }

    res.status(200).json({
      status: true,
      data: {
        code: record.code,
        imageDetails: record.imageDetails,
        isUsed: record.isUsed,
        capturedAt: record.capturedAt,
        expiresAt: record.expiresAt,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      },
    })
  } catch (err) {
    console.error('❌ getImageDetails error:', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

/* -------------------------------------------------- */
/* SWITCH COMPANY - UPDATE UNUSED IMAGE CODE */
/* -------------------------------------------------- */

const switchCompany = async (req, res) => {
  const session = await ImageCode.startSession()
  session.startTransaction()

  try {
    await dbConnect()

    const { companyId: companyCode } = req.body
    const currentSeatId = req.user.user

    if (!companyCode) {
      await session.abortTransaction()
      session.endSession()
      return res.status(400).json({
        status: false,
        msg: 'Company ID is required',
      })
    }

    // Step 1: Find Current Context
    const currentSeat = await Seat.findById(currentSeatId).session(session).lean()
    if (!currentSeat) {
      await session.abortTransaction()
      session.endSession()
      return res.status(401).json({ status: false, msg: 'Invalid user session' })
    }

    // Step 2: Validate Request
    const requestedCompany = await Company.findOne(
      { companyId: companyCode },
      '_id expiredAt companyId companyName createdAt currentPaymentId plan',
    ).lean()

    if (!requestedCompany) {
      await session.abortTransaction()
      session.endSession()
      return res.status(404).json({ status: false, msg: 'Company not found' })
    }

    if (requestedCompany?.expiredAt && Number(requestedCompany.expiredAt) < now()) {
      await session.abortTransaction()
      session.endSession()
      return res.status(400).json({ status: false, msg: 'Company license expired' })
    }

    const newCompanyId = requestedCompany._id

    // Step 3: Find Target Seat
    const newSeat = await Seat.findOne(
      {
        email: currentSeat.email,
        companyId: newCompanyId,
        status: { $in: ['0', '1'] },
      },
      '_id email license validationToken enterpriseId activatedAt createdAt status',
    )
      .sort({ status: -1 })
      .session(session)
      .lean()

    if (!newSeat) {
      await session.abortTransaction()
      session.endSession()
      return res.status(403).json({ status: false, msg: 'You do not have access to this company' })
    }

    // Step 4 & 5: Update Device and IMEI on New Seat

    // Carry over device and IMEI to the new seat
    const newSeatUpdate = {}

    // If the seat is inactive, we MUST activate it so the mobileTokenValidator doesn't reject and log out the user
    if (newSeat.status === '0') {
      newSeatUpdate.status = '1'
    }

    const crypto = require('crypto')
    const validationToken = crypto.randomBytes(6).toString('hex')
    const validationTokenExpiry = now() + 3600

    newSeatUpdate.validationToken = validationToken
    newSeatUpdate.validationTokenExpiry = validationTokenExpiry

    // Check request body first (since mobile might send it), fallback to current seat
    const reqDeviceName = req.body.deviceName || currentSeat.device
    const reqImei = req.body.imei || currentSeat.imei

    if (reqDeviceName) newSeatUpdate.device = reqDeviceName
    if (reqImei) newSeatUpdate.imei = reqImei

    if (Object.keys(newSeatUpdate).length > 0) {
      await Seat.updateOne({ _id: newSeat._id }, { $set: newSeatUpdate }, { session })
    }

    // Step 6: Update User Profile
    const User = require('../../models/User.model')
    await User.findOneAndUpdate(
      { email: currentSeat.email },
      {
        $set: {
          currentCompanyId: newCompanyId.toString(),
          currentCompanyCode: requestedCompany.companyId,
          currentSeatId: newSeat._id.toString(),
          currentLicense: newSeat.license,
          currentInvitationId: newSeat._id.toString(),
        },
      },
      { new: true, session },
    )

    // Update existing unused imageCode's companyId to new company
    // Do NOT generate new code, just update company association
    let updatedCode = null

    // Find all seats for this user to locate their unused image code
    const allSeats = await Seat.find({ email: currentSeat.email }, '_id').session(session).lean()
    const allSeatIds = allSeats.map((s) => s._id.toString())

    // Find any unused code for this user (across all their seats)
    const pendingCode = await ImageCode.findOne({
      isUsed: false,
      seatId: { $in: allSeatIds },
    })
      .session(session)
      .lean()

    if (pendingCode) {
      // First, delete any existing unused code for the new seat to avoid duplicate key error
      await ImageCode.deleteOne({
        isUsed: false,
        seatId: newSeat._id.toString(),
      }).session(session)

      // Then update the current code to the new seat
      updatedCode = await ImageCode.findOneAndUpdate(
        { _id: pendingCode._id },
        {
          $set: {
            companyId: newCompanyId,
            seatId: newSeat._id.toString(),
            licenseEntryId: newSeat._id.toString(),
            updatedAt: Date.now(),
          },
        },
        { new: true, session },
      ).lean()
      console.log(`✅ Updated image code ${updatedCode.code} to company ${companyCode}`)
    }

    // Step 8: Commit Transaction
    await session.commitTransaction()
    session.endSession()

    // Fetch payment transaction for planStartedAt (outside transaction)
    const Transaction = require('../../models/Transaction.model')
    const payment = await Transaction.findOne({ paymentId: requestedCompany.currentPaymentId, type: { $in: [1, 2, 5] } }, 'createdAt')
      .sort({ createdAt: -1 })
      .lean()

    const currentDate = now()

    // Step 9: Return Payload
    res.status(200).json({
      status: true,
      msg: updatedCode ? `Company switched successfully. Image code company updated.` : 'Company switched successfully.',
      data: {
        seatId: enc(newSeat._id.toString(), process.env.ID_SECRET),
        userPlan: requestedCompany.plan || 'Enterprise',
        email: newSeat.email,
        activatedAt: newSeat.activatedAt || currentDate,
        expiredAt: requestedCompany.expiredAt,
        planStartedAt: payment?.createdAt,
        companyName: requestedCompany.companyName,
        licenseId: newSeat.license,
        enterpriseId: newSeat.enterpriseId || requestedCompany.companyId,
        validationToken: validationToken,
        company: {
          _id: requestedCompany._id,
          companyId: requestedCompany.companyId,
          companyName: requestedCompany.companyName,
        },
        imageCode: updatedCode
          ? {
              code: updatedCode.code,
              expiresAt: updatedCode.expiresAt,
              isUsed: updatedCode.isUsed,
              companyId: updatedCode.companyId,
            }
          : null,
      },
    })
  } catch (err) {
    console.error('❌ switchCompany error:', err)
    await session.abortTransaction()
    session.endSession()
    res.status(500).json({
      status: false,
      // msg: 'Something went wrong while switching company',
      msg: 'You’re already a member of this company.',
    })
  }
}

module.exports = {
  generateImageCode,
  updateImageDetails,
  getImageDetails,
  switchCompany,
}

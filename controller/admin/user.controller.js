const Company = require('../../models/Company.model')
const Seat = require('../../models/Seat.model')
const dbConnect = require('../../utils/dbConnect')
const {
  enc,
  generateUniqueId,
  dec,
  queueMail,
  now,
  isValidEmail,
  validateLicenseAvailability,
  calculateLicenseStats,
  getPlanInfo,
} = require('../../utils/utilities')
const {
  buildImageClickCountsForSeats,
  getSeatImageClickCount,
  getSeatLifetimeClickCount,
} = require('../../utils/imageClickCount')
const mongoose = require('mongoose')
const createLog = require('../../models/Logs.model')

const seatAlreadyAdded = async (req, res) => {
  try {
    const { email } = req.query
    if (!email) return res.status(400).json({ msg: 'Email is required' })
    if (!isValidEmail(email)) return res.status(400).json({ msg: 'Invalid email address' })

    const company = req.user.id
    await dbConnect()

    const seat = await Seat.findOne(
      {
        email: email.toLowerCase().trim(),
        companyId: company,
        status: { $in: ['0', '1'] },
      },
      '_id',
    ).lean()

    return res.status(200).json({ status: Boolean(seat) })
  } catch (err) {
    console.log('❌ seatAlreadyAdded err', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getLicenseStats = async (companyId) => {
  await dbConnect()
  const company = await Company.findOne({ _id: companyId }, 'totalSeat usedSeat remainingSeat seatCapacity seatPurchased plan expiredAt companyName').lean()

  if (!company) return null

  // If no plan, return empty stats
  if (!company.plan) {
    return {
      totalSeat: 0,
      usedSeat: 0,
      remainingSeat: 0,
      totalPlanSeats: 0,
      usedLicenses: 0,
      remainingLicenses: 0,
      seatPurchased: 0,
      seatCapacity: 0,
      plan: null,
      hasPlan: false,
      expiredAt: null,
      isExpired: false,
    }
  }

  // Get plan info
  const planInfo = getPlanInfo(company.plan)

  const usedSeat = company.usedSeat !== undefined ? Number(company.usedSeat) : (Number(company.seatPurchased) || 0)
  const remainingSeat = company.remainingSeat !== undefined ? Number(company.remainingSeat) : (Number(company.seatCapacity) || 0)

  if (!planInfo) {
    const totalSeat = company.totalSeat !== undefined ? Number(company.totalSeat) : (usedSeat + remainingSeat)
    return {
      totalSeat: totalSeat,
      usedSeat: usedSeat,
      remainingSeat: remainingSeat,
      totalPlanSeats: totalSeat,
      usedLicenses: usedSeat,
      remainingLicenses: remainingSeat,
      seatPurchased: usedSeat,
      seatCapacity: remainingSeat,
      plan: company.plan,
      hasPlan: true,
      expiredAt: company.expiredAt,
      isExpired: company.expiredAt < now(),
    }
  }

  // Ensure consistency between plan seats and actual counts
  const totalPlanSeats = planInfo.seat !== undefined ? planInfo.seat : (company.totalSeat || usedSeat + remainingSeat)

  // Calculate the actual total from database
  const calculatedTotal = usedSeat + remainingSeat

  // Check for inconsistency
  if (calculatedTotal !== totalPlanSeats || company.totalSeat !== totalPlanSeats) {
    console.warn(
      `⚠️ License count mismatch for company ${companyId}: usedSeat(${usedSeat}) + remainingSeat(${remainingSeat}) = ${calculatedTotal}, but plan seats = ${totalPlanSeats}`,
    )

    // Validate totalPlanSeats before attempting arithmetic
    if (typeof totalPlanSeats !== 'number' || Number.isNaN(totalPlanSeats)) {
      console.warn(`⚠️ Cannot auto-correct for company ${companyId}: plan seat count is not a valid number. Skipping DB update.`)
    } else {
      // Auto-correct by adjusting remainingSeat
      const correctedRemainingSeat = Math.max(0, Number(totalPlanSeats) - usedSeat)
      if (!Number.isFinite(correctedRemainingSeat) || Number.isNaN(correctedRemainingSeat)) {
        console.warn(`⚠️ Computed correctedRemainingSeat is invalid for company ${companyId}. Skipping DB update.`)
      } else {
        console.log(`🔧 Auto-correcting for company ${companyId}: remainingSeat = ${totalPlanSeats} - ${usedSeat} = ${correctedRemainingSeat}`)

        // Update the database
        await Company.updateOne(
          { _id: companyId },
          {
            totalSeat: totalPlanSeats,
            usedSeat: usedSeat,
            remainingSeat: correctedRemainingSeat,
            seatCapacity: correctedRemainingSeat,
            seatPurchased: usedSeat,
            updatedAt: now(),
          },
        )

        company.totalSeat = totalPlanSeats
        company.usedSeat = usedSeat
        company.remainingSeat = correctedRemainingSeat
        company.seatCapacity = correctedRemainingSeat
      }
    }
  }

  const finalTotalSeat = totalPlanSeats
  const finalUsedSeat = usedSeat
  const finalRemainingSeat = company.remainingSeat !== undefined ? company.remainingSeat : Math.max(0, finalTotalSeat - finalUsedSeat)

  const stats = {
    totalSeat: finalTotalSeat,
    usedSeat: finalUsedSeat,
    remainingSeat: finalRemainingSeat,
    totalPlanSeats: finalTotalSeat,
    usedLicenses: finalUsedSeat,
    remainingLicenses: finalRemainingSeat,
    seatPurchased: finalUsedSeat,
    seatCapacity: finalRemainingSeat,
    plan: company.plan,
    hasPlan: true,
    companyName: company.companyName,
    expiredAt: company.expiredAt,
    isExpired: company.expiredAt < now(),
  }

  return stats
}

const addNewUser = async (req, res) => {
  console.log('='.repeat(50))
  console.log('👤 ADD NEW USER API CALLED')
  console.log('Time:', new Date().toISOString())
  console.log('User ID:', req.user.id)
  console.log('Body:', req.body)

  try {
    const { fname, lname, email, role, address, state, city, phone, country, phoneCode } = req.body

    // Validation
    if (!fname || !fname.trim()) {
      return res.status(400).json({ status: false, msg: 'First name is required' })
    }
    if (!lname || !lname.trim()) {
      return res.status(400).json({ status: false, msg: 'Last name is required' })
    }
    if (!email || !email.trim()) {
      return res.status(400).json({ status: false, msg: 'Email is required' })
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ status: false, msg: 'Invalid email address' })
    }

    const { id } = req.user
    await dbConnect()

    // Get company info with license validation
    const company = await Company.findOne({ _id: id }, 'totalSeat usedSeat remainingSeat seatCapacity expiredAt companyId companyName plan seatPurchased').lean()

    if (!company) {
      return res.status(404).json({ status: false, msg: 'Company not found' })
    }

    // Validate license availability
    const validation = validateLicenseAvailability(company, true)
    if (!validation.canAdd) {
      return res.status(400).json({
        status: false,
        msg: validation.reason,
        code: validation.code,
      })
    }

    const cleanEmail = email.trim().toLowerCase()

    // ✅ FIXED: Check if user already exists in THIS company only
    const existingSeatInSameCompany = await Seat.findOne({
      email: cleanEmail,
      companyId: id, // Only check within this company
      status: { $in: ['0', '1'] },
    }).lean()

    if (existingSeatInSameCompany) {
      if (existingSeatInSameCompany.status === '0') {
        return res.status(400).json({
          status: false,
          msg: 'Invitation already sent to this user from your organization.',
        })
      }
      if (existingSeatInSameCompany.status === '1') {
        return res.status(400).json({
          status: false,
          msg: 'This user is already active in your organization.',
        })
      }
    }

    // ✅ Optional: Inform admin if user exists in other companies (but don't block)
    const existingSeatInOtherCompany = await Seat.findOne({
      email: cleanEmail,
      companyId: { $ne: id }, // Check in other companies
      status: { $in: ['0', '1'] },
    }).lean()

    if (existingSeatInOtherCompany) {
      console.log(`ℹ️ Note: User ${cleanEmail} is also registered with another organization.`)
      // You could add this to logs or send a notification
    }

    // Generate unique license ID
    const licenseId = generateUniqueId()

    console.log('Creating seat with license:', licenseId)
    console.log('Current stats - seatPurchased:', company.seatPurchased, 'seatCapacity:', company.seatCapacity)

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Create seat
      const seat = await Seat.create(
        [
          {
            companyId: id,
            fname: fname.trim(),
            lname: lname.trim(),
            email: cleanEmail,
            role: role || 'user',
            phoneCode: phoneCode || null,
            license: licenseId,
            phone: phone || null,
            address: address ? address.trim() : null,
            city: city ? city.trim() : null,
            state: state ? state.trim() : null,
            country: country ? country.trim() : null,
            status: '0', // Pending status
            createdAt: now(),
          },
        ],
        { session },
      )

      console.log('Seat created:', seat[0]._id)

      // Update company seats - increment usedSeat, decrement remainingSeat
      await Company.updateOne(
        { _id: id },
        {
          $inc: {
            usedSeat: 1,
            remainingSeat: -1,
            seatPurchased: 1, // Increment used licenses
            seatCapacity: -1, // Decrement available licenses
          },
          $set: { updatedAt: now() },
        },
        { session },
      )

      await session.commitTransaction()

      // Get updated stats for response
      const updatedStats = await getLicenseStats(id)
      console.log('Updated stats:', updatedStats)

      // Send invitation email in background
      setTimeout(async () => {
        try {
          await queueMail(cleanEmail, `Welcome to GPS Map Camera ENT!`, 'invitation', {
            email: cleanEmail,
            licenseId,
            companyId: company.companyId,
            companyName: company.companyName,
            name: fname.trim(),
          })
          console.log(`📧 Invitation email sent to ${cleanEmail}`)
        } catch (emailError) {
          console.error('Email sending error:', emailError.message)
        }
      }, 0)

      // Create log
      createLog(id, 'User seat added', `${cleanEmail} added as ${role || 'user'}`)

      console.log('✅ User added successfully')
      console.log('='.repeat(50))

      return res.status(201).json({
        status: true,
        msg: 'User added successfully. Invitation sent to email.',
        data: {
          seatId: seat[0]._id,
          license: licenseId,
          email: cleanEmail,
          name: `${fname} ${lname}`,
          status: 'pending',
          licenseStats: updatedStats,
        },
      })
    } catch (err) {
      await session.abortTransaction()
      throw err
    } finally {
      session.endSession()
    }
  } catch (err) {
    console.error('❌ addNewUser error:', err)
    console.error('Stack trace:', err.stack)

    if (err.code === 11000) {
      return res.status(400).json({
        status: false,
        msg: 'User with this email already exists.',
      })
    }

    return res.status(500).json({
      status: false,
      msg: 'Something went wrong. Please try again.',
    })
  }
}

const getSeats = async (req, res) => {
  try {
    const { page, limit, sortBy, order, status, search } = req.body
    const dynamicQry = { companyId: req.user.id }

    if (status != null) {
      dynamicQry.status = status.toString()
    }

    if (search && search.trim()) {
      const searchTerm = search.trim()
      dynamicQry.$or = [
        { fname: { $regex: searchTerm, $options: 'i' } },
        { lname: { $regex: searchTerm, $options: 'i' } },
        { email: { $regex: searchTerm, $options: 'i' } },
      ]
    }

    const sortFields = ['fname', 'device', 'license', 'role', 'createdAt', 'lastActive']
    await dbConnect()

    // First check if company has a plan
    const company = await Company.findOne({ _id: req.user.id }, 'plan').lean()

    if (!company || !company.plan) {
      return res.status(200).json({
        status: true,
        data: {
          data: [],
          totalCount: 0,
          statusCounts: {},
          licenseStats: {
            totalPlanSeats: 0,
            usedLicenses: 0,
            remainingLicenses: 0,
            seatPurchased: 0,
            seatCapacity: 0,
            plan: null,
            hasPlan: false,
          },
        },
      })
    }

    const dbSeats = await Seat.find(dynamicQry)
      .skip(page * limit)
      .limit(limit)
      .sort({ [sortFields[sortBy]]: order })
      .collation({ locale: 'en', strength: 2 })
      .lean()

    // Get image click counts per license entry (seat), not aggregated by email
    const { entryCounts, lifetimeByEmail } = await buildImageClickCountsForSeats(dbSeats, req.user.id)

    const seats = []
    dbSeats.forEach((user) => {
      seats.push({
        id: enc(user._id.toString(), process.env.ID_SECRET),
        fname: user.fname,
        lname: user.lname,
        email: user.email,
        status: user.status,
        license: user.license,
        device: user.device || null,
        imei: user.imei || null,
        createdAt: user.createdAt,
        lastActive: user.lastActive || null,
        phone: user.phone || null,
        city: user.city || null,
        address: user.address || null,
        role: user.role || 'user',
        country: user.country || null,
        state: user.state || null,
        phoneCode: user.phoneCode || null,
        imageClicks: getSeatImageClickCount(user, entryCounts),
        totalClicks: getSeatLifetimeClickCount(user, lifetimeByEmail),
      })
    })

    const totalCount = await Seat.countDocuments({ companyId: req.user.id })

    const groupedData = await Seat.aggregate([
      { $match: { companyId: new mongoose.Types.ObjectId(req.user.id) } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ])

    const statusCounts = {}
    groupedData.forEach((s) => {
      statusCounts[s._id] = s.count
    })

    // Get license stats for the response
    const licenseStats = await getLicenseStats(req.user.id)

    return res.status(200).json({
      status: true,
      data: {
        data: seats,
        totalCount,
        statusCounts,
        licenseStats,
      },
    })
  } catch (err) {
    console.log('❌ getSeats error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const changeSeatStatus = async (req, res) => {
  try {
    const { id, status } = req.body
    if (!id || !status) return res.status(400).json({ msg: 'Invalid request' })

    const decId = dec(id, process.env.ID_SECRET)
    await dbConnect()

    const user = await Seat.findOne({ _id: decId, companyId: req.user.id }).lean()
    if (!user) return res.status(400).json({ msg: 'User not found' })

    const newStatus = status.toString()
    const oldStatus = user.status

    // Prevent invalid status transitions
    if (oldStatus == '2' && newStatus == '3') {
      return res.status(400).json({ msg: `Can't deactivate left user` })
    }
    if (oldStatus == '3') {
      return res.status(400).json({ msg: 'User already Deactivated' })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      await Seat.updateOne({ _id: decId }, { status: newStatus }, { session })

      // Return seat when user is deactivated (status '2') or archived (status '3')
      // Return seat if user was previously pending (status '0') or active (status '1')
      // Both status '0' and '1' consume seats when created, so seat should be returned
      // Don't return seat if user was already deactivated/archived (status '2' or '3')
      if ((newStatus === '2' || newStatus === '3') && (oldStatus === '0' || oldStatus === '1')) {
        console.log(`🔄 Returning seat for user ${user.email}: ${oldStatus} -> ${newStatus}`)
        await Company.updateOne(
          { _id: req.user.id },
          {
            $inc: {
              usedSeat: -1,
              remainingSeat: 1,
              seatCapacity: 1, // Give back the license (increase available)
              seatPurchased: -1, // Decrease used count
            },
            $set: { updatedAt: now() },
          },
          { session },
        )
        console.log(`✅ Seat returned successfully for ${user.email}`)
      }

      await session.commitTransaction()

      const statusText = { 2: 'Deactivated', 3: 'User Removed' }
      const actionText = statusText[newStatus] || 'Status Updated'

      // Get company info for email notification
      const company = await Company.findById(req.user.id, 'companyName companyId').lean()

      // Send notification email for deactivation/archiving
      if ((newStatus === '2' || newStatus === '3') && (oldStatus === '0' || oldStatus === '1')) {
        setTimeout(async () => {
          try {
            await queueMail(user.email, `Account Status Update - GPS Map Camera ENT`, 'seat_revoked', {
              userName: `${user.fname} ${user.lname}`,
              userEmail: user.email,
              companyName: company.companyName,
              companyId: company.companyId,
              licenseCode: user.license,
              action: newStatus === '2' ? 'Deactivated' : 'User Removed',
              actionDate: new Date().toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
              }),
              status: newStatus === '2' ? 'Deactivated' : 'User Removed',
              reason: 'The organization administrator has revoked your access.',
              supportEmail: 'ent-support@gpsmapcamera.com',
            })
            console.log(`📧 Seat revocation email sent to ${user.email}`)
          } catch (emailError) {
            console.error('Email sending error:', emailError.message)
          }
        }, 0)
      }

      createLog(req.user.id, `User ${actionText}`, `${user.email} ${actionText.toLowerCase()}`)

      // Get updated license stats
      const licenseStats = await getLicenseStats(req.user.id)

      return res.status(200).json({
        status: true,
        msg: `User ${actionText.toLowerCase()} successfully`,
        data: { licenseStats },
      })
    } catch (err) {
      await session.abortTransaction()
      throw err
    } finally {
      session.endSession()
    }
  } catch (err) {
    console.log('❌ changeSeatStatus error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const deleteSeat = async (req, res) => {
  try {
    const { id } = req.body
    if (!id) return res.status(400).json({ msg: 'Invalid request' })

    const decId = dec(id, process.env.ID_SECRET)
    await dbConnect()

    const seat = await Seat.findOne({ _id: decId, companyId: req.user.id }).lean()
    if (!seat) return res.status(400).json({ msg: 'User not found' })

    if (seat.status != '0') {
      return res.status(400).json({
        status: false,
        msg: 'Cannot delete already activated user',
      })
    }

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Get company info for email notification before deletion
      const company = await Company.findById(req.user.id, 'companyName companyId').lean()

      // Store seat data for email before deletion
      const seatData = {
        email: seat.email,
        fname: seat.fname,
        lname: seat.lname,
        license: seat.license,
      }

      await Seat.deleteOne({ _id: decId }, { session })

      // Give back the seat - decrement usedSeat, increment remainingSeat
      await Company.updateOne(
        { _id: req.user.id },
        {
          $inc: {
            usedSeat: -1,
            remainingSeat: 1,
            seatCapacity: 1, // Give back the license (increase available)
            seatPurchased: -1, // Decrease used count
          },
          $set: { updatedAt: now() },
        },
        { session },
      )

      await session.commitTransaction()

      // Send deletion notification email
      setTimeout(async () => {
        try {
          await queueMail(seatData.email, `Account Access Revoked - GPS Map Camera ENT`, 'seat_revoked', {
            userName: `${seatData.fname} ${seatData.lname}`,
            userEmail: seatData.email,
            companyName: company.companyName,
            companyId: company.companyId,
            licenseCode: seatData.license,
            action: 'deleted',
            actionDate: new Date().toLocaleDateString('en-US', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
            }),
            status: 'Deleted',
            reason: 'The organization administrator has removed your pending invitation and revoked access.',
            supportEmail: 'ent-support@gpsmapcamera.com',
          })
          console.log(`📧 Seat deletion email sent to ${seatData.email}`)
        } catch (emailError) {
          console.error('Email sending error:', emailError.message)
        }
      }, 0)

      createLog(req.user.id, 'User seat deleted', `${seat.email} deleted`)

      // Get updated license stats
      const licenseStats = await getLicenseStats(req.user.id)

      return res.status(200).json({
        status: true,
        msg: 'User deleted successfully',
        data: { licenseStats },
      })
    } catch (error) {
      await session.abortTransaction()
      throw error
    } finally {
      session.endSession()
    }
  } catch (err) {
    console.log('❌ deleteSeat error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const getLicenseStatsAPI = async (req, res) => {
  try {
    const { id } = req.user
    const licenseStats = await getLicenseStats(id)

    if (!licenseStats) {
      return res.status(404).json({
        status: false,
        msg: 'Company not found',
      })
    }

    return res.status(200).json({
      status: true,
      data: licenseStats,
    })
  } catch (err) {
    console.log('❌ getLicenseStatsAPI error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const updateSeatData = async (req, res) => {
  try {
    const { id, fname, lname, role, address, city, phone, country, state, phoneCode } = req.body

    if (!fname || !fname.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'First name is required',
      })
    }
    if (!lname || !lname.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Last name is required',
      })
    }

    const decId = dec(id, process.env.ID_SECRET)
    await dbConnect()

    const seat = await Seat.findOne({ _id: decId, companyId: req.user.id }).lean()
    if (!seat)
      return res.status(400).json({
        status: false,
        msg: 'User not found',
      })

    if (seat.status == '3') {
      return res.status(400).json({
        status: false,
        msg: 'Cannot update Deactivated user',
      })
    }
    if (seat.status == '2') {
      return res.status(400).json({
        status: false,
        msg: 'Cannot update Left user',
      })
    }

    const updateData = {
      fname: fname.trim(),
      lname: lname.trim(),
      role: role || seat.role,
      address: address ? address.trim() : seat.address,
      city: city ? city.trim() : seat.city,
      phone: phone || seat.phone,
      country: country ? country.trim() : seat.country,
      state: state ? state.trim() : seat.state,
      phoneCode: phoneCode || seat.phoneCode,
    }

    await Seat.updateOne({ _id: decId, companyId: req.user.id }, updateData)

    createLog(req.user.id, 'User details updated', `${seat.email} information updated`)

    return res.status(200).json({
      status: true,
      msg: 'User updated successfully',
    })
  } catch (err) {
    console.log('❌ updateSeatData error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const sendInvite = async (req, res) => {
  try {
    const { id, medium } = req.body
    if (!id || !medium) return res.status(400).json({ msg: 'Invalid request' })

    const decId = dec(id, process.env.ID_SECRET)
    await dbConnect()

    const user = await Seat.findOne(
      {
        _id: decId,
        companyId: req.user.id,
      },
      'email phone companyId license fname status',
    ).lean()

    if (!user) return res.status(400).json({ msg: 'User not found' })
    if (user.status != '0') return res.status(400).json({ msg: 'Cannot send invite to this user' })

    const company = await Company.findOne({ _id: user.companyId }).lean()
    if (!company) return res.status(400).json({ msg: 'Company not found' })

    if (medium === 'mail') {
      if (!user.email) return res.status(400).json({ msg: 'Cannot get user email' })

      await queueMail(user.email, `Welcome to GPS Map Camera ENT!`, 'invitation', {
        email: user.email,
        licenseId: user.license,
        companyId: company.companyId,
        companyName: company.companyName,
        name: user.fname,
      })

      createLog(req.user.id, 'Invitation sent', `${user.email} invited again through mail`)

      return res.status(200).json({
        status: true,
        msg: 'Invitation sent successfully',
      })
    }

    if (medium === 'whatsapp') {
      if (!user.phone) return res.status(400).json({ msg: 'Cannot get user phone' })

      createLog(req.user.id, 'Invitation sent', `${user.email} invitation generated for whatsapp`)

      const message = encodeURIComponent(`Dear ${user.fname},

We are thrilled to have you, and thank you for choosing to join the GPS Map Camera ENT family! We can't wait for you to explore everything our app has to offer!

Your Exclusive Licence Details:
Company Name: ${company.companyName}
ENT ID: ${company.companyId}
License Code: ${user.license}

As a premium user, you have access to powerful tools and features designed just for you. Get ready to explore a world of possibilities!

Let's get started! Download the app from the links below and unlock the full potential of your premium experience:

Play Store:
play.google.com/store/apps/details?id=com.gpsmapcamera.geotagginglocationonphoto&hl=en_IN

App Store:
apps.apple.com/il/app/gps-map-camera-geotag-photos/id1503116917

If you have any questions or need a helping hand, our dedicated support team is just an email away. We're here to ensure your experience is nothing short of amazing!

Welcome aboard, and enjoy using GPS Map Camera ENT!`)

      return res.status(200).json({
        status: true,
        data: {
          url: `https://wa.me/${user.phone}?text=${message}`,
        },
      })
    }
  } catch (err) {
    console.log('❌ sendInvite error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const updateCompanyInfo = async (req, res) => {
  try {
    const { id } = req.user
    const { companyName, logo } = req.body

    if (!companyName || !companyName.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'Company name is required',
      })
    }

    await dbConnect()

    const company = await Company.findOne({ _id: id }, 'plan').lean()
    if (!company)
      return res.status(400).json({
        status: false,
        msg: 'Company not found',
      })

    const updateData = {
      companyName: companyName.trim(),
      updatedAt: now(),
    }

    if (logo) updateData.logo = logo

    await Company.updateOne({ _id: id }, updateData)

    console.log('✅ Company updated:', companyName)

    return res.status(200).json({
      status: true,
      msg: 'Company information updated successfully',
      data: { companyName, logo },
    })
  } catch (err) {
    console.log('❌ updateCompanyInfo error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

const generateLicense = async (req, res) => {
  try {
    const { id } = req.user
    const { fname, lname, email, role } = req.body

    if (!fname || !fname.trim()) {
      return res.status(400).json({
        status: false,
        msg: 'First name is required',
      })
    }
    if (!lname || !lname.trim()) {
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
    if (!isValidEmail(email)) {
      return res.status(400).json({
        status: false,
        msg: 'Invalid email address',
      })
    }

    await dbConnect()

    const company = await Company.findOne({ _id: id }, 'seatCapacity seatPurchased expiredAt companyName plan').lean()

    if (!company)
      return res.status(400).json({
        status: false,
        msg: 'Company not found',
      })

    // Validate license availability
    const validation = validateLicenseAvailability(company, true)
    if (!validation.canAdd) {
      return res.status(400).json({
        status: false,
        msg: validation.reason,
        code: validation.code,
      })
    }

    const cleanEmail = email.trim().toLowerCase()

    // ✅ FIXED: Check if user already exists in THIS company only
    const existingSeatInSameCompany = await Seat.findOne({
      email: cleanEmail,
      companyId: id, // Only check within this company
      status: { $in: ['0', '1', '2', '3'] },
    }).lean()

    if (existingSeatInSameCompany) {
      return res.status(400).json({
        status: false,
        msg: 'This user already exists in your organization.',
      })
    }

    // Generate unique license
    const license = generateUniqueId()

    const session = await mongoose.startSession()
    session.startTransaction()

    try {
      // Create new seat
      const seat = await Seat.create(
        [
          {
            companyId: id,
            fname: fname.trim(),
            lname: lname.trim(),
            email: cleanEmail,
            license,
            role: role || 'user',
            status: '1', // active
            createdAt: now(),
          },
        ],
        { session },
      )

      // Update usedSeat and remainingSeat
      await Company.updateOne(
        { _id: id },
        {
          $inc: {
            usedSeat: 1,
            remainingSeat: -1,
            seatPurchased: 1,
            seatCapacity: -1,
          },
          $set: { updatedAt: now() },
        },
        { session },
      )

      await session.commitTransaction()

      // Get updated license stats
      const licenseStats = await getLicenseStats(id)

      console.log('✅ License generated:', license)

      return res.status(200).json({
        status: true,
        msg: 'License generated successfully',
        data: {
          license,
          seatId: seat[0]._id,
          firstName: fname,
          lastName: lname,
          email: cleanEmail,
          role: role || 'user',
          licenseStats,
        },
      })
    } catch (err) {
      await session.abortTransaction()
      throw err
    } finally {
      session.endSession()
    }
  } catch (err) {
    console.log('❌ generateLicense error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Something went wrong',
    })
  }
}

module.exports = {
  addNewUser,
  getSeats,
  changeSeatStatus,
  updateSeatData,
  sendInvite,
  deleteSeat,
  seatAlreadyAdded,
  updateCompanyInfo,
  generateLicense,
  getLicenseStatsAPI,
}

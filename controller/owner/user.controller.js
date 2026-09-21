const dbConnect = require('../../utils/dbConnect')
const User = require('../../models/User.model')
const Company = require('../../models/Company.model')
const { enc, imageURL } = require('../../utils/utilities')
const BillingInfo = require('../../models/BillingInfo.model')
const Transaction = require('../../models/Transaction.model')

/* =========================
   APP USERS
========================= */
const appUsers = async (req, res) => {
  try {
    const { page = 1, sortBy = 'createdAt', search, order = -1, limit } = req.query

    const pageNum = parseInt(page) || 1
    const rpv = parseInt(limit) || parseInt(process.env.RPV) || 10

    const pipeline = [
      {
        $lookup: {
          from: 'seats',
          localField: 'email',
          foreignField: 'email',
          as: 'seats',
        },
      },
    ]

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { fname: { $regex: search, $options: 'i' } },
            { lname: { $regex: search, $options: 'i' } },
            { email: { $regex: search, $options: 'i' } },
          ],
        },
      })
    }

    // ✅ FIXED facet syntax
    pipeline.push({
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [{ $sort: { [sortBy]: parseInt(order) } }, { $skip: rpv * (pageNum - 1) }, { $limit: rpv }],
      },
    })

    await dbConnect()

    const result = await User.aggregate(pipeline)

    const count = result[0]?.metadata[0]?.total || 0
    let usersData = result[0]?.data || []

    /* =========================
       PERFORMANCE FIX
       fetch companies once
    ========================= */

    const companyIds = [...new Set(usersData.flatMap((u) => (u.seats || []).map((s) => s.companyId).filter(Boolean)))]

    const companies = await Company.find(
      { _id: { $in: companyIds } },
      'companyId companyName email type plan expiredAt createdAt totalSeat usedSeat remainingSeat seatCapacity seatPurchased',
    ).lean()

    const companyMap = {}
    await Promise.all(companies.map(async (c) => {
      // Fetch latest successful transaction for each company
      const latestTransaction = await Transaction.findOne({ 
        userId: c._id, 
        status: 'completed',
        type: { $in: [1, 2, 5] }
      }).sort({ createdAt: -1 }).select('createdAt').lean()

      companyMap[c._id.toString()] = {
        ...c,
        purchasedAt: latestTransaction ? latestTransaction.createdAt : null
      }
    }))

    /* =========================
       ENRICH USERS
    ========================= */

    const enrichedData = usersData.map((user) => {
      const seats = user.seats || []

      const pendingSeats = seats.filter((s) => parseInt(s.status) === 0)
      const activeSeats = seats.filter((s) => parseInt(s.status) === 1)
      const leftSeats = seats.filter((s) => parseInt(s.status) === 2)
      const inactiveSeats = seats.filter((s) => parseInt(s.status) === 3)

      const invitationDetails = seats.map((seat) => {
        const company = companyMap[seat.companyId?.toString()]
        const seatStatus = parseInt(seat.status)

        return {
          seatId: seat._id?.toString(),
          licenseId: seat.license,
          companyName: company?.companyName || 'Unknown Company',
          companyId: company?.companyId || seat.enterpriseId || 'N/A',
          invitedEmail: seat.email,
          role: seat.role || 'User',
          status: seatStatus,
          statusLabel:
            seatStatus === 0
              ? 'Pending'
              : seatStatus === 1
                ? 'Active'
                : seatStatus === 2
                  ? 'User Left'
                  : seatStatus === 3
                    ? 'Deactivated'
                    : 'Unknown',
          device: seat.device,
          imei: seat.imei,
          lastActive: seat.lastActive ? parseInt(seat.lastActive) : null,
          createdAt: seat.createdAt ? parseInt(seat.createdAt) : null,
          plan: company?.plan || 'N/A',
          companyExpiredAt: company?.expiredAt || null,
          purchasedAt: company?.purchasedAt || null,
        }
      })

      return {
        _id: user._id.toString(),
        firstName: user.fname,
        lastName: user.lname,
        email: user.email,
        signupType: user.signupType,
        createdAt: user.createdAt,

        activitySummary: {
          totalInvitations: seats.length,
          pendingCount: pendingSeats.length,
          activeCount: activeSeats.length,
          deactivatedCount: inactiveSeats.length,
          leftCount: leftSeats.length,
        },

        invitations: invitationDetails.sort((a, b) => {
          const order = { 1: 0, 0: 1, 2: 2, 3: 3 }
          return (order[a.status] ?? 999) - (order[b.status] ?? 999)
        }),

        currentActiveCompanies: invitationDetails.filter((i) => i.status === 1),
        pastCompanies: invitationDetails.filter((i) => i.status === 2 || i.status === 3),
        pendingInvitations: invitationDetails.filter((i) => i.status === 0),
      }
    })

    return res.status(200).json({
      status: true,
      data: { data: enrichedData, count },
    })
  } catch (err) {
    console.log('❌ appUsers', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

/* =========================
   COMPANIES
========================= */
const companiesController = async (req, res) => {
  try {
    await dbConnect()

    let { search, page = 1, sortBy = 'createdAt', order = -1, limit } = req.query

    if (search === 'undefined' || search === 'null') search = ''

    const pageNum = parseInt(page) || 1
    const rpv = parseInt(limit) || parseInt(process.env.RPV) || 10

    const query = {}

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { companyName: { $regex: search, $options: 'i' } },
        { companyId: { $regex: search, $options: 'i' } },
        { fName: { $regex: search, $options: 'i' } },
        { lName: { $regex: search, $options: 'i' } },
      ]
    }

    const totalDocs = await Company.countDocuments(query)

    const data = await Company.find(
      query,
      'email fName lName companyName type plan totalSeat usedSeat remainingSeat seatCapacity seatPurchased expiredAt createdAt companyId logo address country',
    )
      .sort({ [sortBy]: parseInt(order) })
      .skip(rpv * (pageNum - 1))
      .limit(rpv)
      .lean()

    const companiesWithBilling = await Promise.all(
      data.map(async (company) => {
        const billingInfo = await BillingInfo.findOne({
          owner: company._id,
          isDeleted: false,
        }).lean()

        const latestTransaction = await Transaction.findOne({
          userId: company._id,
          status: 'completed',
          type: { $in: [1, 2, 5] },
        })
          .sort({ createdAt: -1 })
          .select('createdAt')
          .lean()

        let displayCountry = company.country
        if (!displayCountry || displayCountry.trim() === '') {
          displayCountry = billingInfo?.country || '-'
        }

        company._id = enc(company._id.toString(), process.env.ID_SECRET)
        company.companyName = company.companyName?.trim() || '-'

        if (company.logo) company.logo = imageURL(company.logo, 'logo')

        return {
          ...company,
          country: displayCountry,
          purchasedAt: latestTransaction ? latestTransaction.createdAt : null,
          billingAddress: billingInfo
            ? `${billingInfo.line1}, ${billingInfo.line2}, ${billingInfo.city}, ${billingInfo.state}, ${billingInfo.country} - ${billingInfo.zipcode}`
            : null,
        }
      }),
    )

    return res.status(200).json({
      status: true,
      data: { data: companiesWithBilling, count: totalDocs },
    })
  } catch (err) {
    console.log('❌ companies controller err', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

module.exports = {
  appUsers,
  companies: companiesController,
}

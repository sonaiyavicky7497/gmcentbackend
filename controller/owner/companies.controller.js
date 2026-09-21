// controller/owner/information.controller.js
const mongoose = require('mongoose')
const Company = require('../../models/Company.model')
const CustomPlan = require('../../models/CustomPlan.model')
const Seat = require('../../models/Seat.model')
const ProjectInfo = require('../../models/Projectinfo.model')
const Transaction = require('../../models/Transaction.model')
const planConfig = require('../../utils/trade/plan.json')
const dbConnect = require('../../utils/dbConnect')
const { enc, imageURL, queueMail, isValidEmail, dec } = require('../../utils/utilities')
const jwt = require('jsonwebtoken')
const { buildImageClickCountsForSeats, getSeatImageClickCount, getSeatLifetimeClickCount } = require('../../utils/imageClickCount')

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const getCompanies = async (req, res) => {
  try {
    await dbConnect()
    let { search } = req.query
    console.log('🔍 getCompanies Params:', req.query)

    // Handle case where search might be string "undefined" or "null" from frontend
    if (search === 'undefined' || search === 'null') {
      search = ''
    }

    const query = {}

    if (search) {
      const escapedSearch = escapeRegExp(search)
      query.$or = [
        { email: { $regex: escapedSearch, $options: 'i' } },
        { companyName: { $regex: escapedSearch, $options: 'i' } },
        { companyId: { $regex: escapedSearch, $options: 'i' } },
      ]
    }
    console.log('🔍 getCompanies Query:', JSON.stringify(query))

    const totalDocs = await Company.countDocuments()
    console.log(`📊 Total Companies in DB: ${totalDocs}`)

    const companies = await Company.find(
      query,
      'email fName lName companyName type plan totalSeat usedSeat remainingSeat seatCapacity seatPurchased expiredAt companyId logo country',
    ).lean()

    // Fetch the latest successful transaction date for each company and fallback country from BillingInfo
    const BillingInfo = require('../../models/BillingInfo.model')

    const enrichedCompanies = await Promise.all(
      companies.map(async (company) => {
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
          const billingInfo = await BillingInfo.findOne({ owner: company._id, isDeleted: false }).lean()
          displayCountry = billingInfo?.country || '-'
        }

        return {
          ...company,
          country: displayCountry,
          purchasedAt: latestTransaction ? latestTransaction.createdAt : null,
        }
      }),
    )

    console.log(`✅ Found ${enrichedCompanies.length} companies`)

    const normalizedCompanies = enrichedCompanies.map((company) => ({
      ...company,
      companyName: company.companyName?.trim() || '-',
    }))

    if (normalizedCompanies.length > 0) {
      console.log('📝 Sample Company:', {
        id: normalizedCompanies[0]._id,
        name: normalizedCompanies[0].companyName,
        email: normalizedCompanies[0].email,
        type: normalizedCompanies[0].type,
      })
    }

    // Encrypt company IDs and format logo URLs
    normalizedCompanies.forEach((company) => {
      company._id = enc(company._id.toString(), process.env.ID_SECRET)
      if (company.logo) {
        company.logo = imageURL(company.logo, 'logo')
      }
    })

    return res.status(200).json({ status: true, data: normalizedCompanies, count: normalizedCompanies.length })
  } catch (err) {
    console.log('❌ getCompanies', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getCustomPlanList = async (req, res) => {
  try {
    const { page = 1, sortBy = 'createdAt', search, order = -1 } = req.query

    const pipeline = [
      {
        $lookup: {
          from: 'companies',
          localField: 'userId',
          foreignField: '_id',
          as: 'company',
        },
      },
      { $unwind: '$company' },
    ]

    if (search) {
      pipeline.push({
        $match: {
          $or: [{ 'company.email': { $regex: search, $options: 'i' } }, { 'company.companyName': { $regex: search, $options: 'i' } }],
        },
      })
    }

    pipeline.push({
      $facet: {
        metadata: [{ $count: 'total' }],
        data: [
          {
            $project: {
              _id: 1,
              amount: 1,
              invoiceExpiry: 1,
              status: 1,
              createdAt: 1,
              seat: 1,
              planExpiry: 1,
              updatedAt: 1,
              activatedAt: 1,
              isActive: 1,
              isRefunded: 1,
              refundStatus: 1,
              refundedAt: 1,
              company: {
                _id: 1,
                companyName: 1,
                email: 1,
                plan: 1,
                currentPaymentId: 1,
                totalSeat: 1,
                usedSeat: 1,
                remainingSeat: 1,
                seatCapacity: 1,
                seatPurchased: 1,
                expiredAt: 1,
              },
            },
          },
          { $sort: { [sortBy]: parseInt(order) } },
          { $skip: parseInt((process.env.RPV || 10) * (page - 1)) },
          { $limit: parseInt(process.env.RPV || 10) },
        ],
      },
    })

    await dbConnect()
    const result = await CustomPlan.aggregate(pipeline)

    const count = result[0]?.metadata[0]?.total || 0
    const customPlans = result[0]?.data || []

    // ✅ Encrypt plan IDs and company IDs, ensure all numeric types
    customPlans.forEach((plan) => {
      plan._id = enc(plan._id.toString(), process.env.ID_SECRET)

      // ✅ CRITICAL: Ensure all numeric fields are actual numbers
      plan.status = Number(plan.status)
      plan.amount = Number(plan.amount)
      plan.seat = Number(plan.seat)
      plan.planExpiry = Number(plan.planExpiry)
      plan.invoiceExpiry = Number(plan.invoiceExpiry)
      plan.createdAt = Number(plan.createdAt)
      plan.isRefunded = Boolean(plan.isRefunded || plan.status === 5)
      plan.refundStatus = plan.refundStatus || (plan.status === 5 ? 'refunded' : null)
      if (plan.status !== 1) {
        plan.isActive = false
      }

      if (plan.updatedAt) plan.updatedAt = Number(plan.updatedAt)
      if (plan.activatedAt) plan.activatedAt = Number(plan.activatedAt)
      if (plan.refundedAt) plan.refundedAt = Number(plan.refundedAt)

      if (plan.company && plan.company._id) {
        plan.company._id = enc(plan.company._id.toString(), process.env.ID_SECRET)
      }
    })

    console.log(
      '📋 Custom Plans returned:',
      customPlans.map((p) => ({
        id: p._id.substring(0, 8) + '...',
        status: p.status,
        statusType: typeof p.status,
        isActive: p.isActive,
      })),
    )

    return res.status(200).json({ status: true, data: { data: customPlans, count } })
  } catch (err) {
    console.log('❌ getCustomPlanList', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getEnterpriseDetails = async (req, res) => {
  try {
    let { enterpriseId } = req.params

    if (!enterpriseId) return res.status(400).json({ msg: 'Enterprise ID is required' })

    // Trim whitespace
    enterpriseId = enterpriseId.trim()
    console.log(`🔍 getEnterpriseDetails: Searching for '${enterpriseId}' (CASE-SENSITIVE)`)

    await dbConnect()

    // 1. Get Company (Customer/Enterprise) - Try both enterpriseId and companyId
    // First try exact case-sensitive match on companyId
    let company = await Company.findOne({ companyId: enterpriseId }).lean()

    // If not found by companyId, try by _id (in case enterpriseId is actually an encrypted/regular ID)
    if (!company) {
      company = await Company.findOne({ _id: enterpriseId }).lean()
    }

    // If still not found, try lookup by email
    if (!company) {
      company = await Company.findOne({ email: enterpriseId }).lean()
    }

    console.log(`🔍 Search result:`, {
      searchedFor: enterpriseId,
      found: !!company,
      foundCompanyId: company?.companyId,
      foundId: company?._id,
      matchType: company
        ? company.companyId === enterpriseId
          ? '✅ companyId match'
          : company.email === enterpriseId
            ? '✅ email match'
            : '✅ _id match'
        : '❌ No match found',
    })

    // If not found, return error
    if (!company) {
      console.log(`❌ Enterprise/Company not found for id: ${enterpriseId}`)
      // Debug: print existing IDs to help identifying the issue
      try {
        const allIds = await Company.find({}, 'companyId _id').limit(20).lean()
        console.log('Existing companyIds (first 20):', allIds.map((c) => c.companyId).filter(Boolean))
        console.log(
          'Existing _ids (first 20):',
          allIds.map((c) => c._id.toString()),
        )
        console.log(`💡 Note: Looking for exact match of '${enterpriseId}'`)
        console.log(
          `💡 Available companyId matches (case-sensitive):`,
          allIds.filter((c) => c.companyId && c.companyId.toLowerCase() === enterpriseId.toLowerCase()).map((c) => c.companyId),
        )
      } catch (logErr) {
        console.log('Error listing IDs', logErr)
      }

      return res.status(404).json({
        msg: 'Enterprise/Company not found',
        details:
          process.env.NODE_ENV !== 'production'
            ? {
                note: 'Enterprise ID must match either companyId or _id exactly',
                searchedFor: enterpriseId,
              }
            : undefined,
      })
    }

    // Store raw company ID for database queries
    const rawCompanyId = company._id

    // Check and sync refunds if company has an active current payment
    if (company.currentPaymentId) {
      try {
        const { syncRefundsFromRazorpay } = require('../../utils/trade/paymentHandler')
        await syncRefundsFromRazorpay(company.currentPaymentId, rawCompanyId)
        const refreshed = await Company.findById(rawCompanyId).lean()
        if (refreshed) company = refreshed
      } catch (syncErr) {
        console.warn('⚠️ Error syncing refunds in getEnterpriseDetails:', syncErr?.message || syncErr)
      }
    }

    console.log('📋 Company found:', {
      companyId: company.companyId,
      rawCompanyId: rawCompanyId.toString(),
      companyName: company.companyName,
      plan: company.plan,
      caseMatch: '✅ Exact match',
    })

    // 2. Get Users (Seats)
    const users = await Seat.find({ companyId: rawCompanyId }).lean()

    // Get image click counts per license entry (seat), not aggregated by email
    const { entryCounts, lifetimeByEmail } = await buildImageClickCountsForSeats(users, rawCompanyId)

    users.forEach((user) => {
      user.imageClicks = getSeatImageClickCount(user, entryCounts)
      user.totalClicks = getSeatLifetimeClickCount(user, lifetimeByEmail)
    })

    // 3. Get Project Details
    const projects = await ProjectInfo.find({ owner: rawCompanyId }).lean()

    // 4. Get Billing Information
    const BillingInfo = require('../../models/BillingInfo.model')
    const billingInfo = await BillingInfo.findOne({ owner: rawCompanyId, isDeleted: false }).lean()

    // Format billing address if exists
    let billingAddress = null
    if (billingInfo) {
      billingAddress = `${billingInfo.line1 || ''}${billingInfo.line2 ? ', ' + billingInfo.line2 : ''}${billingInfo.city ? ', ' + billingInfo.city : ''}${billingInfo.state ? ', ' + billingInfo.state : ''}${billingInfo.country ? ', ' + billingInfo.country : ''}${billingInfo.zipcode ? ' - ' + billingInfo.zipcode : ''}`
    }

    // 5. ✅ FIXED: Plan Details - Get the most recent ACTIVE custom plan first
    let planDetails = null
    if (company.plan) {
      // ✅ First, get ALL custom plans for this company to debug
      const allCustomPlans = await CustomPlan.find({ userId: rawCompanyId }).sort({ createdAt: -1 }).lean()

      console.log(
        '📋 ALL Custom Plans for this company:',
        allCustomPlans.map((p) => ({
          _id: p._id.toString(),
          status: p.status,
          statusType: typeof p.status,
          isActive: p.isActive,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          activatedAt: p.activatedAt,
          status: p.status,
        })),
      )

      let selectedPlan = null

      if (allCustomPlans.length > 0) {
        // ✅ Priority 1: Find an active (paid) plan with status = 1 and isActive = true
        const activePlans = allCustomPlans.filter((p) => Number(p.status) === 1 && p.isActive === true)
        console.log('📋 Active plans found (status=1 & isActive=true):', activePlans.length)

        if (activePlans.length > 0) {
          // Get the most recently activated one
          selectedPlan = activePlans.sort((a, b) => {
            const aTime = a.activatedAt || a.updatedAt || a.createdAt
            const bTime = b.activatedAt || b.updatedAt || b.createdAt
            return bTime - aTime
          })[0]
          console.log('✅ Selected ACTIVE plan:', selectedPlan._id.toString(), 'status:', selectedPlan.status)
        }

        // ✅ Priority 2: If no plan with isActive=true, check any paid plan (status = 1)
        if (!selectedPlan) {
          const paidPlans = allCustomPlans.filter((p) => Number(p.status) === 1)
          if (paidPlans.length > 0) {
            selectedPlan = paidPlans.sort((a, b) => {
              const aTime = a.activatedAt || a.updatedAt || a.createdAt
              const bTime = b.activatedAt || b.updatedAt || b.createdAt
              return bTime - aTime
            })[0]
            console.log('ℹ️ Selected fallback PAID plan:', selectedPlan._id.toString())
          }
        }

        // ✅ Priority 2: If no active plan, get the most recent pending plan
        if (!selectedPlan) {
          const pendingPlans = allCustomPlans.filter((p) => Number(p.status) === 0)
          if (pendingPlans.length > 0) {
            selectedPlan = pendingPlans.sort((a, b) => b.createdAt - a.createdAt)[0]
            console.log('⏳ Selected PENDING plan:', selectedPlan._id.toString(), 'status:', selectedPlan.status)
          }
        }

        // ✅ Priority 3: Fallback to most recent plan regardless of status
        if (!selectedPlan) {
          selectedPlan = allCustomPlans[0]
          console.log('📋 Selected FALLBACK plan:', selectedPlan._id.toString(), 'status:', selectedPlan.status)
        }
      }

      if (selectedPlan) {
        const currentTime = Math.floor(Date.now() / 1000)
        const isExpired = selectedPlan.planExpiry && Number(selectedPlan.planExpiry) < currentTime

        planDetails = {
          ...selectedPlan,
          type: 'custom',
          // ✅ Ensure all numeric fields are actual numbers
          status: Number(selectedPlan.status),
          amount: Number(selectedPlan.amount),
          seat: Number(selectedPlan.seat),
          planExpiry: Number(selectedPlan.planExpiry),
          invoiceExpiry: Number(selectedPlan.invoiceExpiry),
          createdAt: Number(selectedPlan.createdAt),
          updatedAt: selectedPlan.updatedAt ? Number(selectedPlan.updatedAt) : null,
          activatedAt: selectedPlan.activatedAt ? Number(selectedPlan.activatedAt) : null,
          isActive: selectedPlan.isActive || false,
          isExpired,
          // Encrypt custom plan ID
          _id: enc(selectedPlan._id.toString(), process.env.ID_SECRET),
        }

        console.log('📋 FINAL Plan Details being returned:', {
          _id: planDetails._id.substring(0, 10) + '...',
          status: planDetails.status,
          statusType: typeof planDetails.status,
          isActive: planDetails.isActive,
          isExpired: planDetails.isExpired,
        })
      } else {
        // No custom plans found, check for standard plan
        const standardPlan = planConfig.find((p) => p.name === company.plan)
        if (standardPlan) {
          planDetails = { ...standardPlan, type: 'standard' }
        } else {
          planDetails = { name: company.plan, type: 'unknown' }
        }
      }
    }

    // 6. Get Latest Successful Transaction for Purchased Date (for all plan types)
    try {
      const latestTransaction = await Transaction.findOne({
        userId: rawCompanyId,
        status: 'completed',
        type: { $in: [1, 2, 5] }, // Purchase, Upgrade, Renewal
      })
        .sort({ createdAt: -1 })
        .lean()

      if (latestTransaction && planDetails) {
        planDetails.purchasedAt = latestTransaction.createdAt
        console.log(`💰 Found latest transaction for ${company.plan}:`, new Date(latestTransaction.createdAt * 1000))
      } else if (planDetails && planDetails.type === 'custom' && planDetails.activatedAt) {
        // Fallback for custom plans if transaction not found
        planDetails.purchasedAt = planDetails.activatedAt
      }
    } catch (transErr) {
      console.error('❌ Error fetching latest transaction:', transErr.message)
    }

    // Format company logo URL
    if (company.logo) {
      company.logo = imageURL(company.logo, 'logo')
    }

    company.companyName = company.companyName?.trim() || '-'

    // Assumptions: the Company record itself represents the Admin/Owner
    const adminDetails = {
      fName: company.fName,
      lName: company.lName,
      email: company.email,
      phone: company.phone,
      type: company.type,
    }

    // Add billing address to company object
    company.billingAddress = billingAddress
    company.addressInformation = {
      country: billingInfo?.country || '-',
      state: billingInfo?.state || '-',
      city: billingInfo?.city || '-',
      area: billingInfo?.line2 || '-',
      streetAddress: billingInfo?.line1 || '-',
      officeAddress: company.address || '-',
      landmark: '-',
      pincode: billingInfo?.zipcode || '-',
    }

    // ✅ IMPORTANT: Encrypt company._id before sending to frontend
    // This encrypted ID should be used for assigning custom plans
    company._id = enc(rawCompanyId.toString(), process.env.ID_SECRET)

    // Also encrypt user and project IDs for consistency
    users.forEach((user) => {
      if (user._id) {
        user._id = enc(user._id.toString(), process.env.ID_SECRET)
      }
    })

    projects.forEach((project) => {
      if (project._id) {
        project._id = enc(project._id.toString(), process.env.ID_SECRET)
      }
    })

    const response = {
      status: true,
      data: {
        company: company,
        admin: adminDetails,
        users: users,
        projects: projects,
        plan: planDetails,
      },
    }

    console.log('📤 Response plan status:', response.data.plan?.status, 'type:', typeof response.data.plan?.status)
    console.log('📤 Billing Address included:', !!billingAddress)

    return res.status(200).json(response)
  } catch (err) {
    console.log('❌ getEnterpriseDetails', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const sendCompanyMail = async (req, res) => {
  try {
    const { recipientEmail, companyData } = req.body

    if (!recipientEmail || !companyData) {
      return res.status(400).json({ status: false, msg: 'Recipient email and company data are required' })
    }

    if (!isValidEmail(recipientEmail)) {
      return res.status(400).json({ status: false, msg: 'Invalid recipient email' })
    }

    const senderEmail = req.user?.email || process.env.MAIL_SENDBY || 'no-reply@gpsmapcamera.com'

    const createdDate = companyData.createdAt ? new Date(companyData.createdAt * 1000).toLocaleDateString() : '-'

    // Format billing address if object
    let billingStr = companyData.billingAddress || '-'
    if (typeof billingStr === 'object') {
      billingStr =
        `${billingStr.line1 || ''} ${billingStr.city || ''} ${billingStr.state || ''} ${billingStr.country || ''} ${billingStr.zipcode || ''}`.trim()
    }

    const context = {
      senderEmail,
      companyName: companyData.companyName || '-',
      companyType: companyData.type || '-',
      website: companyData.website || '-',
      enterpriseId: companyData.companyId || '-',
      createdDate,
      fName: companyData.fName || '-',
      lName: companyData.lName || '-',
      email: companyData.email || '-',
      phone: companyData.phone || '-',
      companyAddress: companyData.address || '-',
      billingAddress: billingStr,
      location: companyData.location || '-',
    }

    await queueMail(recipientEmail, 'Company Enquiry Details', 'companyDetails', context)

    return res.status(200).json({ status: true, msg: 'Mail sent successfully' })
  } catch (err) {
    console.log('❌ sendCompanyMail', err)
    res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

const getCompanyFullDetails = async (req, res) => {
  try {
    const { id } = req.params
    await dbConnect()

    let companyIdStr = id
    try {
      const { dec } = require('../../utils/utilities')
      const decrypted = dec(id, process.env.ID_SECRET)
      if (decrypted) companyIdStr = decrypted
    } catch (e) {}

    let company = await Company.findById(companyIdStr).lean()
    if (!company) {
      return res.status(404).json({ success: false, message: 'Company not found' })
    }

    const BillingInfo = require('../../models/BillingInfo.model')
    const billingInfo = await BillingInfo.findOne({ owner: company._id, isDeleted: false }).lean()

    const Seat = require('../../models/Seat.model')
    const Department = mongoose.models.Department || require('../../models/Department.model')

    const usersCount = await Seat.countDocuments({ companyId: company._id })
    let deptsCount = 0
    try {
      deptsCount = await Department.countDocuments({ companyId: company._id })
    } catch (e) {}

    const activeUsersCount = await Seat.countDocuments({ companyId: company._id, isActive: true })

    return res.status(200).json({
      success: true,
      data: {
        basicInformation: {
          companyName: company.companyName,
          logo: company.logo ? imageURL(company.logo, 'logo') : null,
          companyId: company.companyId,
          industryType: company.industryType || '-',
          businessType: company.type || '-',
          registrationNumber: company.registrationNumber || '-',
          gstNumber: company.gstNumber || '-',
          panNumber: company.panNumber || '-',
          establishmentYear: company.establishmentYear || '-',
          companySize: company.companySize || '-',
          website: company.website || '-',
          status: company.isActive ? 'Active' : 'Inactive',
          registrationDate: company.createdAt,
        },
        contactInformation: {
          officialEmail: company.email,
          phoneNumber: company.phone,
          alternateContactNumber: company.alternatePhone || '-',
          hrEmail: company.hrEmail || '-',
          supportEmail: company.supportEmail || '-',
          companyWebsite: company.website || '-',
          socialMediaLinks: company.socialMediaLinks || {},
        },
        adminInformation: {
          ownerName: `${company.fName || ''} ${company.lName || ''}`.trim() || '-',
          adminName: `${company.fName || ''} ${company.lName || ''}`.trim() || '-',
          adminEmail: company.email,
          adminPhone: company.phone || '-',
          totalEmployees: usersCount,
          totalDepartments: deptsCount,
          activeUsers: activeUsersCount,
          subscriptionPlan: company.plan || '-',
          planExpiryDate: company.expiredAt || '-',
          lastLogin: company.lastLogin || '-',
          createdBy: 'System',
        },
        addressInformation: {
          country: billingInfo?.country || '-',
          state: billingInfo?.state || '-',
          city: billingInfo?.city || '-',
          area: billingInfo?.line2 || '-',
          streetAddress: billingInfo?.line1 || '-',
          officeAddress: company.address || '-',
          landmark: billingInfo?.landmark || '-',
          pincode: billingInfo?.zipcode || '-',
        },
      },
    })
  } catch (err) {
    console.error('getCompanyFullDetails', err)
    res.status(500).json({ success: false, message: 'Server error' })
  }
}

const getExportDetails = async (req, res) => {
  try {
    await dbConnect()
    const { search, page = 1, limit = 1000, sortBy = 'createdAt', order = -1, startDate, endDate } = req.query

    const skip = (parseInt(page) - 1) * parseInt(limit)
    const query = {}

    if (search) {
      const escapedSearch = escapeRegExp(search)
      query.$or = [
        { email: { $regex: escapedSearch, $options: 'i' } },
        { companyName: { $regex: escapedSearch, $options: 'i' } },
        { companyId: { $regex: escapedSearch, $options: 'i' } },
        { fName: { $regex: escapedSearch, $options: 'i' } },
        { lName: { $regex: escapedSearch, $options: 'i' } },
      ]
    }

    if (startDate && endDate) {
      query.createdAt = {
        $gte: parseInt(startDate),
        $lte: parseInt(endDate),
      }
    }

    const sortObj = {}
    sortObj[sortBy] = parseInt(order)

    const total = await Company.countDocuments(query)
    const companies = await Company.find(query).sort(sortObj).skip(skip).limit(parseInt(limit)).lean()

    const BillingInfo = require('../../models/BillingInfo.model')

    const formattedData = await Promise.all(
      companies.map(async (company) => {
        const billingInfo = await BillingInfo.findOne({ owner: company._id, isDeleted: false }).lean()

        // Construct detailed billing address based on user's requirements
        const bAddr = billingInfo
          ? [billingInfo.line1, billingInfo.line2, billingInfo.city, billingInfo.state, billingInfo.country, billingInfo.zipcode]
              .filter(Boolean)
              .join(', ')
          : '-'

        return {
          ...company,
          adminName: `${company.fName || ''} ${company.lName || ''}`.trim(),
          fullAddress: `${company.address || ''}, ${company.city || ''}, ${company.state || ''}, ${company.country || ''}`
            .replace(/^, |, , /g, '')
            .trim(),
          billingAddress: bAddr,
          addressInformation: {
            country: billingInfo?.country || '-',
            state: billingInfo?.state || '-',
            city: billingInfo?.city || '-',
            area: billingInfo?.line2 || '-',
            streetAddress: billingInfo?.line1 || '-',
            officeAddress: company.address || '-',
            landmark: billingInfo?.landmark || '-',
            pincode: billingInfo?.zipcode || '-',
          },
          logo: company.logo ? imageURL(company.logo, 'logo') : null,
          id: enc(company._id.toString(), process.env.ID_SECRET),
        }
      }),
    )

    return res.status(200).json({
      status: true,
      data: formattedData,
      pagination: {
        total,
        page: parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    })
  } catch (err) {
    console.error('❌ getExportDetails Error:', err)
    res.status(500).json({ msg: 'Failed to fetch export data' })
  }
}

const getPreviewToken = async (req, res) => {
  try {
    let { companyId } = req.params
    if (!companyId) return res.status(400).json({ msg: 'Company ID is required' })

    companyId = companyId.trim()
    await dbConnect()

    let company = await Company.findOne({ companyId }).lean()
    if (!company) {
      company = await Company.findOne({ _id: companyId }).lean()
    }
    if (!company) {
      company = await Company.findOne({ email: companyId }).lean()
    }

    if (!company) {
      return res.status(404).json({ status: false, msg: 'Company not found' })
    }

    const payload = {
      user: {
        id: company._id,
        readOnly: true,
        viewMode: 'admin-preview',
      },
    }

    // Token expires in 1 hour
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '1h' })

    return res.status(200).json({ status: true, token, companyId: company.companyId })
  } catch (err) {
    console.error('❌ getPreviewToken Error:', err)
    return res.status(500).json({ status: false, msg: 'Failed to generate preview token' })
  }
}

module.exports = { getCompanies, getCustomPlanList, getEnterpriseDetails, sendCompanyMail, getCompanyFullDetails, getExportDetails, getPreviewToken }

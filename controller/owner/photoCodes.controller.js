const mongoose = require('mongoose')
const ImageCode = require('../../models/ImageCode.model')
const Company = require('../../models/Company.model')
const dbConnect = require('../../utils/dbConnect')
const { dec } = require('../../utils/utilities')
const { applyPhotoCodeFilters } = require('../../utils/imageClickCount')

/**
 * Resolve the company for an owner user.
 * The owner JWT contains: { id, email, role, type, companyId, companyCode }
 * - companyId = Company._id.toString()
 * - companyCode = Company.companyId (the string code like "GMC001")
 *
 * Query companyId may be an encrypted owner-panel id, a Mongo ObjectId,
 * or the enterprise code string (Company.companyId).
 */
const resolveCompanyContext = async (user, queryCompanyId) => {
  try {
    await dbConnect()

    const findCompanyByLookupId = async (rawId) => {
      if (!rawId) return null

      let lookupId = String(rawId).trim()
      try {
        const decrypted = dec(lookupId, process.env.ID_SECRET)
        if (decrypted) lookupId = decrypted
      } catch (e) {
        // Keep the original value when decryption is not applicable.
      }

      if (mongoose.Types.ObjectId.isValid(lookupId)) {
        const company = await Company.findById(lookupId, '_id companyId').lean()
        if (company) return company
      }

      return Company.findOne({ companyId: lookupId }, '_id companyId').lean()
    }

    // Priority 1: company selected in the owner dashboard query params
    if (queryCompanyId) {
      const company = await findCompanyByLookupId(queryCompanyId)
      if (company?._id) {
        return { companyObjectId: company._id, enterpriseCode: company.companyId }
      }
    }

    // Priority 2: companyCode from the JWT token (Company.companyId string)
    if (user?.companyCode) {
      const company = await Company.findOne({ companyId: user.companyCode }, '_id companyId').lean()
      if (company?._id) {
        return { companyObjectId: company._id, enterpriseCode: company.companyId }
      }
    }

    // Priority 3: companyId from JWT token (Company._id as string)
    const directCompanyId = user?.companyId || user?.company || user?.company_id || user?.companyID
    if (directCompanyId) {
      const company = await findCompanyByLookupId(directCompanyId)
      if (company?._id) {
        return { companyObjectId: company._id, enterpriseCode: company.companyId }
      }
    }

    // Priority 4: Find company by owner email
    const email = String(user?.email || '').trim().toLowerCase()
    if (email) {
      const company = await Company.findOne(
        { $or: [{ email }, { email: { $regex: `^${email}$`, $options: 'i' } }] },
        '_id companyId',
      ).lean()
      if (company?._id) {
        return { companyObjectId: company._id, enterpriseCode: company.companyId }
      }
    }

    return null
  } catch (error) {
    console.error('resolveCompanyContext error:', error)
    return null
  }
}

const getOwnerPhotoCodes = async (req, res) => {
  try {
    await dbConnect()

    const {
      page = '1',
      limit = '10',
      search = '',
      fromDate = '',
      toDate = '',
      status = 'all',
      companyId: queryCompanyId,
      licenseEntryId = '',
      userEmail = '',
    } = req.query
    const pageNumber = Math.max(Number(page) || 1, 1)
    const pageLimit = Math.max(Number(limit) || 10, 1)
    const trimmedSearch = String(search || '').trim()

    // Resolve the selected company — same companyId field used by the admin API
    const companyContext = await resolveCompanyContext(req.user, queryCompanyId)

    if (!companyContext?.companyObjectId) {
      return res.status(200).json({
        success: true,
        data: [],
        total: 0,
        page: pageNumber,
        totalPages: 1,
      })
    }

    const query = applyPhotoCodeFilters(companyContext.companyObjectId, {
      search: trimmedSearch,
      status,
      fromDate,
      toDate,
      licenseEntryId,
      userEmail,
    })

    const total = await ImageCode.countDocuments(query)
    const totalPages = Math.max(Math.ceil(total / pageLimit), 1)
    const data = await ImageCode.find(query)
      .sort({ createdAt: -1 })
      .skip((pageNumber - 1) * pageLimit)
      .limit(pageLimit)
      .lean()

    return res.status(200).json({
      success: true,
      data,
      total,
      page: pageNumber,
      totalPages,
    })
  } catch (err) {
    console.error('getOwnerPhotoCodes error:', err)
    return res.status(500).json({ success: false, msg: 'Something went wrong' })
  }
}

const getOwnerPhotoCodeById = async (req, res) => {
  try {
    await dbConnect()

    const { companyId: queryCompanyId } = req.query
    const companyContext = await resolveCompanyContext(req.user, queryCompanyId)

    if (!companyContext?.companyObjectId) {
      return res.status(404).json({ success: false, msg: 'GMC Photo code not found' })
    }

    const photoCode = await ImageCode.findOne({
      _id: req.params.id,
      companyId: companyContext.companyObjectId,
    }).lean()

    if (!photoCode) {
      return res.status(404).json({ success: false, msg: 'GMC Photo code not found' })
    }

    return res.status(200).json({ success: true, data: photoCode })
  } catch (err) {
    console.error('getOwnerPhotoCodeById error:', err)
    return res.status(500).json({ success: false, msg: 'Something went wrong' })
  }
}

module.exports = {
  getOwnerPhotoCodes,
  getOwnerPhotoCodeById,
}

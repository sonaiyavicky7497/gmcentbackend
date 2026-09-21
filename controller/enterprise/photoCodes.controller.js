const ImageCode = require('../../models/ImageCode.model')
const Company = require('../../models/Company.model')
const dbConnect = require('../../utils/dbConnect')
const { applyPhotoCodeFilters } = require('../../utils/imageClickCount')

const getEnterprisePhotoCodes = async (req, res) => {
  try {
    await dbConnect()

    const companyId = req.user?.id
    if (!companyId) {
      return res.status(401).json({ success: false, msg: 'Invalid token' })
    }

    const company = await Company.findById(companyId, 'companyId').lean()
    if (!company || !company.companyId) {
      return res.status(401).json({ success: false, msg: 'Enterprise not found' })
    }

    const {
      page = '1',
      limit = '10',
      search = '',
      fromDate = '',
      toDate = '',
      status = 'all',
      licenseEntryId = '',
      userEmail = '',
    } = req.query
    const pageNumber = Math.max(Number(page) || 1, 1)
    const pageLimit = Math.max(Number(limit) || 10, 1)

    const query = applyPhotoCodeFilters(companyId, {
      search,
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
    console.error('getEnterprisePhotoCodes error:', err)
    return res.status(500).json({ success: false, msg: 'Something went wrong' })
  }
}

module.exports = {
  getEnterprisePhotoCodes,
}

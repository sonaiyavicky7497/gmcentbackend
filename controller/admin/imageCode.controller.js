const ImageCode = require('../../models/ImageCode.model')
const dbConnect = require('../../utils/dbConnect')
const { applyPhotoCodeFilters } = require('../../utils/imageClickCount')

const getPhotoCodes = async (req, res) => {
  try {
    await dbConnect()

    const companyId = req.user?.id
    if (!companyId) {
      return res.status(401).json({ status: false, msg: 'Invalid token' })
    }

    const { limit = 10, page = 0, search = '', status, licenseEntryId = '', userEmail = '' } = req.body
    const pageLimit = Number(limit) || 10
    const pageNumber = Number(page) || 0

    const filters = applyPhotoCodeFilters(companyId, {
      search,
      status,
      licenseEntryId,
      userEmail,
    })

    const total = await ImageCode.countDocuments(filters)
    const data = await ImageCode.find(filters)
      .sort({ createdAt: -1 })
      .skip(pageNumber * pageLimit)
      .limit(pageLimit)
      .lean()

    return res.status(200).json({ status: true, data: { data, total } })
  } catch (err) {
    console.error('getPhotoCodes error:', err)
    return res.status(500).json({ status: false, msg: 'Something went wrong' })
  }
}

module.exports = {
  getPhotoCodes,
}

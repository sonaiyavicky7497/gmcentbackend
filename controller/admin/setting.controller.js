const dbConnect = require('../../utils/dbConnect')
const AdminConfig = require('../../models/AdminConfig.model')
const createLog = require('../../models/Logs.model')
const { now } = require('../../utils/utilities')

const updateSetting = async (req, res) => {
  try {
    const { id } = req.user
    const { metaKey, metaValue } = req.body
    if (!metaKey) return res.status(400).json({ msg: 'Something went wrong' })
    await dbConnect()
    const existed = await AdminConfig.findOne({ owner: id, metaKey }).lean()
    createLog(id, `Setting Updated`, `Manual Location ${metaValue ? 'enabled' : 'disabled'}`)
    if (existed) {
      // update
      await AdminConfig.findOneAndUpdate({ owner: id, metaKey }, { metaValue, updatedAt: now() })
      return res.status(200).json({ status: true, msg: 'Setting updated successfully' })
    }
    // create
    await AdminConfig.create({ owner: id, metaKey, metaValue, createdAt: now(), updatedAt: now() })
    return res.status(200).json({ status: true, msg: 'Setting updated successfully' })
  } catch (err) {
    console.log('❌ updateSetting', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getSettings = async (req, res) => {
  try {
    const { id } = req.user
    const { metaKeys } = req.body
    await dbConnect()
    const settings = await AdminConfig.find({ owner: id, metaKey: { $in: metaKeys } }, 'metaKey metaValue').lean()
    return res.status(200).json({ status: true, data: settings })
  } catch (err) {
    console.log('❌ getSettings', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

module.exports = { updateSetting, getSettings }

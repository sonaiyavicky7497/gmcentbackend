const multer = require('multer')
const path = require('path')
const fs = require('fs')
const ProjectInfo = require('../../models/Projectinfo.model')
const Company = require('../../models/Company.model')
const dbConnect = require('../../utils/dbConnect')
const { enc, dec, now } = require('../../utils/utilities')
const planConfig = require('../../utils/trade/plan.json')
const createLog = require('../../models/Logs.model')

const uploadPermission = async (userId, type) => {
  const user = await Company.findOne({ _id: userId }, 'plan expiredAt').lean()

  if (!user || !user.plan) {
    return { plan: null, limitAvailable: 0, limitGiven: 0, isPlanExpired: false, hasPlan: false }
  }

  // Check if plan is expired
  const nowTimestamp = Math.floor(Date.now() / 1000)
  const isPlanExpired = !user.expiredAt || user.expiredAt < nowTimestamp

  const limit = planConfig.find((item) => item.name === user.plan)?.[type] || 0

  let limitAvailable = 'infinity'
  if (limit !== 'infinity') {
    const total = await ProjectInfo.countDocuments({ owner: userId, metaKey: type })
    limitAvailable = isPlanExpired ? 0 : limit - total
  } else if (isPlanExpired) {
    limitAvailable = 0
  }

  return {
    plan: user.plan,
    limitAvailable: isPlanExpired ? 0 : limitAvailable,
    limitGiven: limit,
    isPlanExpired,
    hasPlan: true,
  }
}

// Multer storage configuration
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/project-logo/'
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    cb(null, `projectLogo-${Date.now()}${path.extname(file.originalname)}`)
  },
})

const upload = multer({
  storage: storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // Max file size: 2MB
  fileFilter: function (req, file, cb) {
    const filetypes = /jpeg|jpg|png/
    const mimetype = filetypes.test(file.mimetype)
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase())

    if (mimetype && extname) {
      return cb(null, true)
    } else {
      cb(new Error('Only JPEG, JPG, and PNG files are allowed'))
    }
  },
}).single('file')

exports.addLogo = (req, res) => {
  upload(req, res, async function (err) {
    try {
      if (err) return res.status(400).json({ msg: err })

      if (!req.file) return res.status(400).json({ msg: 'Please upload a file' })

      await dbConnect()
      const { limitAvailable, plan, isPlanExpired } = await uploadPermission(req.user.id, 'logo')

      if (isPlanExpired) {
        return res.status(400).json({ msg: 'Your plan has expired. Please renew your plan to add logos.' })
      }

      if (!plan) {
        return res.status(400).json({ msg: 'Please purchase the plan for using this functionality' })
      }
      if (limitAvailable <= 0) {
        return res.status(400).json({ msg: `You have reached the limit of adding logos for your ${plan} plan.` })
      }
      await ProjectInfo.create({
        owner: req.user.id,
        metaKey: 'logo',
        metaValue: req.file.filename,
        status: 1,
        createdAt: now(),
      })
      createLog(req.user.id, 'Logo uploaded')
      res.status(201).json({ status: true, msg: 'Logo uploaded' })
    } catch (err) {
      console.log('❌ addLogo', err)
      res.status(500).json({ msg: 'Something went wrong' })
    }
  })
}

exports.getLogo = async (req, res) => {
  try {
    await dbConnect()
    const { limit, page } = req.body
    const projectLogo = await ProjectInfo.find({ owner: req.user.id, metaKey: 'logo' }, 'metaValue status')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean()

    const data = projectLogo.map((item) => ({
      id: enc(item._id.toString(), process.env.ID_SECRET),
      logo: process.env.FILE_SOURCE + 'project-logo/' + item.metaValue,
      status: item.status,
    }))
    const total = await ProjectInfo.countDocuments({ owner: req.user.id, metaKey: 'logo' })
    const { limitAvailable, limitGiven, isPlanExpired, plan } = await uploadPermission(req.user.id, 'logo')
    res.status(200).json({
      status: true,
      data: {
        data,
        total,
        limitAvailable,
        limitGiven,
        isPlanExpired,
        plan,
        hasPlan: !!plan,
      },
    })
  } catch (err) {
    console.log('❌ getLogo', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.addCompanyName = async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ msg: 'Please enter name' })
    await dbConnect()
    const { limitAvailable, plan, isPlanExpired } = await uploadPermission(req.user.id, 'companyName')

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Please renew your plan to add company names.' })
    }

    if (!plan) {
      return res.status(400).json({ msg: 'Please purchase the plan for using this functionality' })
    }
    if (limitAvailable <= 0) {
      return res.status(400).json({ msg: `You have reached the limit of adding company names for your ${plan} plan.` })
    }
    const isDataExist = await ProjectInfo.findOne({ owner: req.user.id, metaKey: 'companyName', metaValue: req.body.name }).lean()
    if (isDataExist) return res.status(400).json({ msg: 'This name is already exist' })
    await ProjectInfo.create({
      owner: req.user.id,
      metaKey: 'companyName',
      metaValue: req.body.name,
      status: 1,
      createdAt: now(),
    })
    createLog(req.user.id, 'Company Name added', req.body.name)
    res.status(201).json({ status: true, msg: 'Company name added' })
  } catch (err) {
    console.log('❌ addCompanyName', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

exports.getCompanyName = async (req, res) => {
  try {
    const { limit, page } = req.body
    await dbConnect()

    const companyName = await ProjectInfo.find({ owner: req.user.id, metaKey: 'companyName' }, 'metaValue status')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean()

    const total = await ProjectInfo.countDocuments({
      owner: req.user.id,
      metaKey: 'companyName',
    })
    const data = companyName.map((item) => ({
      id: enc(item._id.toString(), process.env.ID_SECRET),
      name: item.metaValue,
      status: item.status,
    }))
    const { limitAvailable, limitGiven, isPlanExpired, plan } = await uploadPermission(req.user.id, 'companyName')
    res.status(200).json({
      status: true,
      data: {
        data,
        total,
        limitAvailable,
        limitGiven,
        isPlanExpired,
        plan,
        hasPlan: !!plan,
      },
    })
  } catch (err) {
    console.log('❌ getCompanyName', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.updateCompanyName = async (req, res) => {
  try {
    const { id, name } = req.body
    if (!id || !name) return res.status(400).json({ msg: 'Something went wrong' })

    await dbConnect()

    // Check if plan is expired
    const user = await Company.findOne({ _id: req.user.id }, 'expiredAt').lean()
    const nowTimestamp = Math.floor(Date.now() / 1000)
    const isPlanExpired = !user.expiredAt || user.expiredAt < nowTimestamp

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Cannot update company names.' })
    }

    const isDataExist = await ProjectInfo.findOne({ owner: req.user.id, metaKey: 'companyName', metaValue: req.body.name }).lean()
    const ogId = dec(id, process.env.ID_SECRET)
    if (isDataExist?._id == ogId) return res.status(400).json({ status: true, msg: 'Project name updated' })
    if (isDataExist) return res.status(400).json({ msg: 'This name is already exist' })
    await ProjectInfo.findByIdAndUpdate(ogId, { metaValue: name })

    createLog(req.user.id, `companyName Updated`)
    res.status(200).json({ status: true, msg: 'Company name updated' })
  } catch (err) {
    console.log('❌ updateCompanyName', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.addProjectName = async (req, res) => {
  try {
    if (!req.body.name) return res.status(400).json({ msg: 'Please enter name' })
    await dbConnect()
    const { limitAvailable, plan, isPlanExpired } = await uploadPermission(req.user.id, 'projectName')

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Please renew your plan to add project names.' })
    }

    if (!plan) {
      return res.status(400).json({ msg: 'Please purchase the plan for using this functionality' })
    }
    if (limitAvailable <= 0) {
      return res.status(400).json({ msg: `You have reached the limit of adding project names for your ${plan} plan.` })
    }
    const isDataExist = await ProjectInfo.findOne({ owner: req.user.id, metaKey: 'projectName', metaValue: req.body.name }, '_id').lean()

    if (isDataExist) return res.status(400).json({ msg: 'This name is already exist' })
    await ProjectInfo.create({
      owner: req.user.id,
      metaKey: 'projectName',
      metaValue: req.body.name,
      status: 1,
      createdAt: now(),
    })
    createLog(req.user.id, 'Project Name added', req.body.name)
    res.status(201).json({ status: true, msg: 'Project name added' })
  } catch (err) {
    console.log('❌ addProjectName', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

exports.getProjectName = async (req, res) => {
  try {
    const { limit, page } = req.body
    await dbConnect()
    const projectName = await ProjectInfo.find({ owner: req.user.id, metaKey: 'projectName' }, 'status metaValue')
      .sort({ createdAt: -1 })
      .skip(page * limit)
      .limit(limit)
      .lean()
    const data = projectName.map((item) => {
      return {
        id: enc(item._id.toString(), process.env.ID_SECRET),
        name: item.metaValue,
        status: item.status,
      }
    })
    const total = await ProjectInfo.countDocuments({ owner: req.user.id, metaKey: 'projectName' })
    const { limitAvailable, limitGiven, isPlanExpired, plan } = await uploadPermission(req.user.id, 'projectName')
    res.status(200).json({
      status: true,
      data: {
        data,
        total,
        limitAvailable,
        limitGiven,
        isPlanExpired,
        plan,
        hasPlan: !!plan,
      },
    })
  } catch (err) {
    console.log('❌ getProjectName', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.updateProjectName = async (req, res) => {
  try {
    const { id, name } = req.body
    if (!id || !name) return res.status(400).json({ msg: 'Something went wrong' })

    await dbConnect()

    // Check if plan is expired
    const user = await Company.findOne({ _id: req.user.id }, 'expiredAt').lean()
    const nowTimestamp = Math.floor(Date.now() / 1000)
    const isPlanExpired = !user.expiredAt || user.expiredAt < nowTimestamp

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Cannot update project names.' })
    }

    const isDataExist = await ProjectInfo.findOne({ owner: req.user.id, metaKey: 'projectName', metaValue: req.body.name }, '_id').lean()
    const ogId = dec(id, process.env.ID_SECRET)
    if (isDataExist?._id == ogId) return res.status(400).json({ status: true, msg: 'Project name updated' })
    if (isDataExist) return res.status(400).json({ msg: 'This name is already exist' })
    await ProjectInfo.findByIdAndUpdate(ogId, { metaValue: name })
    res.status(200).json({ status: true, msg: 'Project name updated' })
    createLog(req.user.id, `ProjectName Updated`)
  } catch (err) {
    console.log('❌ updateProjectName', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

// other actions
exports.deleteRecord = async (req, res) => {
  try {
    const { id, isPhoto } = req.body

    if (!id) return res.status(400).json({ msg: 'Something went wrong' })
    await dbConnect()

    // Check if plan is expired
    const user = await Company.findOne({ _id: req.user.id }, 'expiredAt').lean()
    const nowTimestamp = Math.floor(Date.now() / 1000)
    const isPlanExpired = !user.expiredAt || user.expiredAt < nowTimestamp

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Cannot delete records.' })
    }

    const item = await ProjectInfo.findById(dec(id, process.env.ID_SECRET), 'metaValue metaKey')
    if (isPhoto) {
      fs.unlink('uploads/project-logo/' + item.metaValue, (err) => {
        if (err) {
          console.log('❌ deleteRecord', err)
          return res.status(501).json({ msg: 'Something went wrong' })
        }
      })
    }
    await ProjectInfo.findByIdAndDelete(dec(id, process.env.ID_SECRET))
    createLog(req.user.id, `${item.metaKey} Removed`, item.metaValue)
    res.status(200).json({ status: true, msg: 'Record deleted' })
  } catch (err) {
    console.log('❌ deleteRecord', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.inactiveRecord = async (req, res) => {
  try {
    const { id, isActive } = req.body

    if (!id) return res.status(400).json({ msg: 'Something went wrong' })

    await dbConnect()

    // Check if plan is expired
    const user = await Company.findOne({ _id: req.user.id }, 'expiredAt').lean()
    const nowTimestamp = Math.floor(Date.now() / 1000)
    const isPlanExpired = !user.expiredAt || user.expiredAt < nowTimestamp

    if (isPlanExpired) {
      return res.status(400).json({ msg: 'Your plan has expired. Cannot modify records.' })
    }

    const record = await ProjectInfo.findByIdAndUpdate(dec(id, process.env.ID_SECRET), { status: isActive ? 1 : 0 })
    const msg = `${record.metaKey === 'logo' ? 'Logo' : 'Record'} ${isActive ? 'activated' : 'inactivated'}`
    createLog(req.user.id, `${record.metaKey} ${isActive ? 'activated' : 'inactivated'}`, record.metaValue)
    res.status(200).json({ status: true, msg })
  } catch (err) {
    console.log('❌ inactiveRecord', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

exports.getCounts = async (req, res) => {
  try {
    const { id } = req.user
    await dbConnect()
    const logo = await ProjectInfo.countDocuments({ owner: id, metaKey: 'logo' })
    const company = await ProjectInfo.countDocuments({ owner: id, metaKey: 'companyName' })
    const project = await ProjectInfo.countDocuments({ owner: id, metaKey: 'projectName' })
    res.status(200).json({ status: true, data: { logo, company, project } })
  } catch (err) {
    console.log('❌ getCounts', err)
    res.status(501).json({ msg: 'Something went wrong' })
  }
}

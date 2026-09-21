const multer = require('multer')
const path = require('path')
const fs = require('fs')
const dbConnect = require('../../utils/dbConnect')
const Company = require('../../models/Company.model')
const { isValidUrl } = require('../../utils/utilities')
const { upsertRazorpayCustomer } = require('../../utils/razorpay')
const createLog = require('../../models/Logs.model')

// Multer storage configuration

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = 'uploads/logo/'
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true })
    }
    cb(null, uploadDir)
  },
  filename: function (req, file, cb) {
    cb(null, `${file.fieldname}-${Date.now()}${path.extname(file.originalname)}`)
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

exports.uploadFile = (req, res) => {
  upload(req, res, async function (err) {
    try {
      if (err) return res.status(400).json({ msg: err })

      const body = req.body
      if (body.email) delete body.email
      if (body.companyId) delete body.companyId
      if (!req.file) delete body.logo

      const trimmedBody = {}
      for (let key in body) {
        if (typeof body[key] === 'string') {
          trimmedBody[key] = body[key].trim()
        } else {
          trimmedBody[key] = body[key]
        }
      }

      await dbConnect()

      // Fetch existing company to get current fName, lName, and email
      const company = await Company.findOne({ _id: req.user.id }).lean()
      if (!company) {
        return res.status(404).json({ msg: 'Company not found' })
      }

      const fName = trimmedBody.fName || company.fName
      const lName = trimmedBody.lName || company.lName
      const email = company.email // Email is usually not updatable via this API
      const phone = trimmedBody.phone || company.phone
      const phoneCode = trimmedBody.phoneCode || company.phoneCode

      if (!req.file) {
        await Company.updateOne({ _id: req.user.id }, { $set: trimmedBody })

        // Update Razorpay with full name and correct email
        try {
          await upsertRazorpayCustomer(
            `${fName} ${lName}`.trim(),
            email,
            phone ? phoneCode + phone : '',
            trimmedBody.gstin || company.gstin,
            '',
            company.razorpayCustomerId,
          )
        } catch (razorpayErr) {
          console.warn('⚠️ Razorpay update failed during profile update:', razorpayErr.message)
        }

        createLog(req.user.id, 'Company profile updated')
        return res.status(201).json({ status: true, msg: 'Your profile has been successfully updated' })
      }

      const oldImage = company.logo

      if (oldImage && !isValidUrl(oldImage)) {
        fs.unlink(`uploads/logo/${oldImage}`, (err) => {
          if (err) {
            console.log('err in delete', err)
            return res.status(500).json({ msg: 'Something went wrong' })
          }
        })
      }
      await Company.updateOne({ _id: req.user.id }, { $set: { ...trimmedBody, logo: req.file.filename } })
      createLog(req.user.id, 'Company profile updated')
      res.status(201).json({ status: true, msg: 'Your profile has been successfully updated' })
    } catch (err) {
      console.log('❌ uploadFile', err)
      res.status(500).json({ msg: 'Something went wrong' })
    }
  })
}

exports.deleteProfileLogo = async (req, res) => {
  try {
    await dbConnect()
    const oldImage = (await Company.findOne({ _id: req.user.id }, 'logo').lean()).logo
    if (oldImage && !isValidUrl(oldImage)) {
      fs.unlink(`uploads/logo/${oldImage}`, (err) => {
        if (err) {
          console.log('err in delete', err)
          return res.status(500).json({ msg: 'Something went wrong' })
        }
      })
    }
    await Company.updateOne({ _id: req.user.id }, { $set: { logo: null } })
    res.status(201).json({ status: true, msg: 'Profile photo deleted' })
  } catch (err) {
    console.log('❌ deleteProfileLogo', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

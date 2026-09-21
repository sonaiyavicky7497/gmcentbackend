const Projectinfo = require('../../models/Projectinfo.model')
const Seat = require('../../models/Seat.model')
const Company = require('../../models/Company.model')
const dbConnect = require('../../utils/dbConnect')
const { now } = require('../../utils/utilities')

const getLogo = async (req, res) => {
  try {
    const { user, company } = req.user

    await dbConnect()
    
    // Fetch seat with latest data
    const seat = await Seat.findOne({ _id: user }).lean()
    if (!seat) return res.status(401).json({ status: false, msg: 'Invalid user' })
    
    // Return appropriate message for archived/deactivated users
    if (seat.status == '2') return res.status(200).json({ 
      status: true, 
      msg: 'User is Left',
      data: [] 
    })
    if (seat.status == '3') return res.status(200).json({ 
      status: true, 
      msg: 'User is Deactivated',
      data: [] 
    })
    
    // Check company license
    const companyData = await Company.findById(company, 'expiredAt').lean()
    if (!companyData) return res.status(401).json({ status: false, msg: 'Invalid Company' })

    if (companyData.expiredAt < now()) {
      return res.status(403).json({ 
        status: false, 
        msg: 'Company plan expired',
        data: [] 
      })
    }

    const logos = await Projectinfo.find({ metaKey: 'logo', owner: req.user.company, status: 1 }, { _id: 0, metaValue: 1 })
      .sort({ createdAt: -1 })
      .lean()

    const data = []
    logos.map((d) => data.push(process.env.FILE_SOURCE + 'project-logo/' + d.metaValue))

    res.status(200).json({ status: true, data })
  } catch (err) {
    console.log('❌ getLogo', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getProjectName = async (req, res) => {
  try {
    const { user, company } = req.user

    await dbConnect()
    
    // Fetch seat with latest data
    const seat = await Seat.findOne({ _id: user }).lean()
    if (!seat) return res.status(401).json({ status: false, msg: 'Invalid user' })
    
    // Return appropriate message for archived/deactivated users
    if (seat.status == '2') return res.status(200).json({ 
      status: true, 
      msg: 'User is Left',
      data: [] 
    })
    if (seat.status == '3') return res.status(200).json({ 
      status: true, 
      msg: 'User is Deactivated',
      data: [] 
    })
    
    // Check company license
    const companyData = await Company.findById(company, 'expiredAt').lean()
    if (!companyData) return res.status(401).json({ status: false, msg: 'Invalid Company' })

    if (companyData.expiredAt < now()) {
      return res.status(403).json({ 
        status: false, 
        msg: 'Company plan expired',
        data: [] 
      })
    }

    const projectNames = await Projectinfo.find({ metaKey: 'projectName', owner: req.user.company, status: 1 }, { _id: 0, metaValue: 1 })
      .sort({ createdAt: -1 })
      .lean()

    const data = []
    projectNames.map((d) => data.push(d.metaValue))

    res.status(200).json({ status: true, data })
  } catch (err) {
    console.log('❌ getProjectName', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getCompanyName = async (req, res) => {
  try {
    const { user, company } = req.user

    await dbConnect()
    
    // Fetch seat with latest data
    const seat = await Seat.findOne({ _id: user }).lean()
    if (!seat) return res.status(401).json({ status: false, msg: 'Invalid user' })
    
    // Return appropriate message for archived/deactivated users
    if (seat.status == '2') return res.status(200).json({ 
      status: true, 
      msg: 'User is Left',
      data: [] 
    })
    if (seat.status == '3') return res.status(200).json({ 
      status: true, 
      msg: 'User is Deactivated',
      data: [] 
    })
    
    // Check company license
    const companyData = await Company.findById(company, 'expiredAt').lean()
    if (!companyData) return res.status(401).json({ status: false, msg: 'Invalid Company' })

    if (companyData.expiredAt < now()) {
      return res.status(403).json({ 
        status: false, 
        msg: 'Company plan expired',
        data: [] 
      })
    }

    const companyName = await Projectinfo.find({ metaKey: 'companyName', owner: req.user.company, status: 1 }, { _id: 0, metaValue: 1 })
      .sort({ createdAt: -1 })
      .lean()

    const data = []
    companyName.map((d) => data.push(d.metaValue))

    res.status(200).json({ status: true, data })
  } catch (err) {
    console.log('❌ getCompanyName', err)
    res.status(500).json({ msg: 'Something went wrong' })
  }
}

module.exports = { getLogo, getProjectName, getCompanyName }

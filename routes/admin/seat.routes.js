// sub user management

const {
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
} = require('../../controller/admin/user.controller.js')
const express = require('express')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')
const bodyTrimmer = require('../../middleware/bodyTrimmer.js')

const userRoute = express.Router()

userRoute.get('/checkUserExistence', adminTokenValidator, seatAlreadyAdded)
userRoute.post('/addNewUser', adminTokenValidator, bodyTrimmer, addNewUser)
userRoute.post('/getseats', adminTokenValidator, getSeats)
userRoute.put('/changeSeatStatus', adminTokenValidator, changeSeatStatus)
userRoute.delete('/deleteSeat', adminTokenValidator, deleteSeat)
userRoute.put('/updateSeatData', adminTokenValidator, bodyTrimmer, updateSeatData)
userRoute.post('/sendInvite', adminTokenValidator, sendInvite)
userRoute.post('/updateCompanyInfo', adminTokenValidator, bodyTrimmer, updateCompanyInfo)
userRoute.post('/generateLicense', adminTokenValidator, bodyTrimmer, generateLicense)
userRoute.get('/getLicenseStats', adminTokenValidator, getLicenseStatsAPI)

module.exports = userRoute

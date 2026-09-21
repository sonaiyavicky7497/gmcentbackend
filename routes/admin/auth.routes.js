const {
  signUp,
  login,
  companyInfo,
  googleLogin,
  changePassword,
  verifyOTP,
  regenerateOTP,
  sendResetPasswordLink,
  resetPassword,
  sendQuery,
  sendFeedback,
} = require('../../controller/admin/auth.controller.js')
const { uploadFile, deleteProfileLogo } = require('../../controller/admin/updateCompany.controller.js')

const express = require('express')
const verifyRecaptcha = require('../../middleware/verifyRecaptcha.js')
const bodyTrimmer = require('../../middleware/bodyTrimmer.js')
const limiter = require('../../middleware/reqLimiter.js')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')

const authRoute = express.Router()

// FIXED: Added bodyTrimmer before verifyRecaptcha
authRoute.post('/signup', bodyTrimmer, verifyRecaptcha, signUp)
authRoute.post('/login', bodyTrimmer, limiter, login)
authRoute.post('/googleLogin', bodyTrimmer, googleLogin)
authRoute.post('/getcompanyinfo', bodyTrimmer, adminTokenValidator, companyInfo)

authRoute.post('/updateCompany', bodyTrimmer, adminTokenValidator, uploadFile)
authRoute.post('/deleteProfileLogo', bodyTrimmer, adminTokenValidator, deleteProfileLogo)

authRoute.post('/changePassword', bodyTrimmer, adminTokenValidator, changePassword)
authRoute.post('/verifyOtp', bodyTrimmer, limiter, verifyOTP)
authRoute.post('/regenerateOtp', bodyTrimmer, regenerateOTP)
authRoute.post('/sendResetPasswordLink', bodyTrimmer, sendResetPasswordLink)
authRoute.post('/resetPassword', bodyTrimmer, resetPassword)

authRoute.post('/sendQuery', bodyTrimmer, adminTokenValidator, sendQuery)
authRoute.post('/sendFeedback', bodyTrimmer, adminTokenValidator, sendFeedback)

module.exports = authRoute

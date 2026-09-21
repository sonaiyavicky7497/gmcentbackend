const {
  login,
  deactivateMe,
  getConfigs,
  getUserInfo,
  getAvailableSeat,
  userEntry,
  signup,
  resendOTP,
  googleLogin,
  appleLogin,
  sendOTP,
  userValidation,
  checkGoogleUserExists,
  checkAppleUserExists,
  changePassword,
  deleteUserByEmail,
} = require('../../controller/mobile/auth.controller.js')
const express = require('express')
const limiter = require('../../middleware/reqLimiter.js')
const { mobileTokenValidator, mobileTokenValidatorLoose, thirdPartyShield } = require('../../middleware/auth.middleware.js')
const { sendResetPasswordLink } = require('../../controller/admin/auth.controller.js')

const projectInfoForMobile = express.Router()

projectInfoForMobile.post('/signup', thirdPartyShield, signup)
projectInfoForMobile.post('/sendOTP', thirdPartyShield, sendOTP)
projectInfoForMobile.post('/googleauth', thirdPartyShield, googleLogin)
projectInfoForMobile.post('/appleauth', thirdPartyShield, appleLogin)
projectInfoForMobile.put('/resendotp', limiter, thirdPartyShield, resendOTP)
projectInfoForMobile.post('/login', limiter, thirdPartyShield, login)
projectInfoForMobile.get('/availableseats', thirdPartyShield, getAvailableSeat)
projectInfoForMobile.post('/userentry', thirdPartyShield, userEntry)
projectInfoForMobile.post('/sendResetPasswordLink', sendResetPasswordLink)
projectInfoForMobile.post('/uservalidation', userValidation)

projectInfoForMobile.get('/getuserinfo', thirdPartyShield, mobileTokenValidatorLoose, getUserInfo)
projectInfoForMobile.put('/deactiveme', thirdPartyShield, mobileTokenValidator, deactivateMe)
projectInfoForMobile.post('/getconfigs', thirdPartyShield, mobileTokenValidatorLoose, getConfigs)
projectInfoForMobile.put('/change-password', thirdPartyShield, mobileTokenValidator, changePassword)

// ✅ NEW: Account Deletion Endpoints
projectInfoForMobile.post('/delete-user', thirdPartyShield, limiter, deleteUserByEmail) // For email-based deletion with password confirmation

projectInfoForMobile.post('/check-google-user', thirdPartyShield, checkGoogleUserExists)
projectInfoForMobile.post('/check-apple-user', thirdPartyShield, checkAppleUserExists)

module.exports = projectInfoForMobile

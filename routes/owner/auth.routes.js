// routes/owner/auth.js
const express = require('express')
const ownerAuth = express.Router()
const {
  ownerLogin,
  ownerSignupRequest,
  ownerSignupVerify,
  ownerForgotPassword,
  ownerVerifyOtp,
  ownerResetPassword,
  ownerResendOtp,
} = require('../../controller/owner/auth.controller.js')

ownerAuth.post('/login', ownerLogin)
ownerAuth.post('/signup-request', ownerSignupRequest) // Step 1
ownerAuth.post('/signup-verify', ownerSignupVerify)

ownerAuth.post('/forgot-password', ownerForgotPassword)
ownerAuth.post('/verify-otp', ownerVerifyOtp)
ownerAuth.post('/reset-password', ownerResetPassword)
ownerAuth.post('/resend-otp', ownerResendOtp)

module.exports = ownerAuth

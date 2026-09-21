const express = require('express')
const router = express.Router()
const { 
  generateImageCode, 
  updateImageDetails, 
  getImageDetails,
  switchCompany  // ✅ Import the new function
} = require('../../controller/mobile/imageCode.controller')
const { mobileTokenValidator, mobileTokenValidatorLoose } = require('../../middleware/auth.middleware')

// Generate a new unique image code
router.post('/generate-code', mobileTokenValidator, generateImageCode)

// Update image details and capture time for a code
router.post('/update-details', mobileTokenValidator, updateImageDetails)

// Get all details associated with an image code
router.get('/get-details', getImageDetails)

// ✅ Switch company - Update unused image code to new company
router.post('/switch-company', mobileTokenValidatorLoose, switchCompany)

module.exports = router
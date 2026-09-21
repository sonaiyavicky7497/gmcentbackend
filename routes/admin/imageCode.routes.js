const express = require('express')
const router = express.Router()
const { getPhotoCodes } = require('../../controller/admin/imageCode.controller')
const bodyTrimmer = require('../../middleware/bodyTrimmer.js')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')

router.post('/getphotocodes', bodyTrimmer, adminTokenValidator, getPhotoCodes)

module.exports = router

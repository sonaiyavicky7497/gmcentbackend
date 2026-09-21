const express = require('express')
const router = express.Router()
const { getEnterprisePhotoCodes } = require('../../controller/enterprise/photoCodes.controller')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')

router.get('/photo-codes', adminTokenValidator, getEnterprisePhotoCodes)

module.exports = router

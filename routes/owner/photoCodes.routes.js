const router = require('express').Router()
const { ownerTokenValidator } = require('../../middleware/auth.middleware')
const { getOwnerPhotoCodes, getOwnerPhotoCodeById } = require('../../controller/owner/photoCodes.controller')

router.get('/photo-codes', ownerTokenValidator, getOwnerPhotoCodes)
router.get('/photo-codes/:id', ownerTokenValidator, getOwnerPhotoCodeById)

module.exports = router

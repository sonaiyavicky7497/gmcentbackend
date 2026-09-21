const express = require('express')
const { updateSetting, getSettings } = require('../../controller/admin/setting.controller.js')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')

const settingRoute = express.Router()
settingRoute.post('/updateSetting', adminTokenValidator, updateSetting)
settingRoute.post('/getSetting', adminTokenValidator, getSettings)

module.exports = settingRoute

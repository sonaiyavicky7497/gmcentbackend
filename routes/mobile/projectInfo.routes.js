const { getLogo, getProjectName, getCompanyName } = require('../../controller/mobile/project.controller.js')
const express = require('express')

const { mobileTokenValidatorLoose } = require('../../middleware/auth.middleware.js')

const projectInfoForMobile = express.Router()

// Use the loose validator so controllers receive archived/deactivated
// seats and can return appropriate responses instead of middleware 401.
projectInfoForMobile.get('/getlogo', mobileTokenValidatorLoose, getLogo)
projectInfoForMobile.get('/getprojectname', mobileTokenValidatorLoose, getProjectName)
projectInfoForMobile.get('/getcompanyname', mobileTokenValidatorLoose, getCompanyName)

module.exports = projectInfoForMobile

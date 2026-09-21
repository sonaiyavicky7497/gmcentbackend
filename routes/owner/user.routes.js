const express = require('express')
const ownerUserRoute = express.Router()
const { ownerTokenValidator } = require('../../middleware/auth.middleware.js')
const { appUsers, companies } = require('../../controller/owner/user.controller.js')

ownerUserRoute.get('/appusers', ownerTokenValidator, appUsers)
ownerUserRoute.get('/companies', ownerTokenValidator, companies)

module.exports = ownerUserRoute

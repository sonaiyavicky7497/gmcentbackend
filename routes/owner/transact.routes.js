const express = require('express')
const ownerTransactRoute = express.Router()
const { assignPlan, deletePlan } = require('../../controller/owner/transaction.controller.js')
const { ownerTokenValidator } = require('../../middleware/auth.middleware.js')

ownerTransactRoute.post('/customPlan/:companyId(*)', ownerTokenValidator, assignPlan)
ownerTransactRoute.delete('/customPlan/:planId(*)', ownerTokenValidator, deletePlan)

module.exports = ownerTransactRoute

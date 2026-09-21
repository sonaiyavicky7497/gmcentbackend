const express = require('express')
const router = express.Router()
const reportController = require('../../controller/owner/report.controller')
const { ownerTokenValidator } = require('../../middleware/auth.middleware')

router.get('/', ownerTokenValidator, reportController.getReports)
router.get('/export/csv', ownerTokenValidator, reportController.exportCSV)
router.get('/export/excel', ownerTokenValidator, reportController.exportExcel)
router.get('/export/pdf', ownerTokenValidator, reportController.exportPDF)

module.exports = router

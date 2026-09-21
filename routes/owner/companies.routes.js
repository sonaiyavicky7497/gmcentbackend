const router = require('express').Router()
const { ownerTokenValidator } = require('../../middleware/auth.middleware')
const {
  getCompanies,
  getCustomPlanList,
  getEnterpriseDetails,
  sendCompanyMail,
  getCompanyFullDetails,
  getExportDetails,
  getPreviewToken,
} = require('../../controller/owner/companies.controller')

router.get('/', ownerTokenValidator, getCompanies)
router.get('/custom-plan', ownerTokenValidator, getCustomPlanList)
router.get('/export-details', ownerTokenValidator, getExportDetails)
router.get('/details/:enterpriseId', ownerTokenValidator, getEnterpriseDetails)
router.get('/:id/details', ownerTokenValidator, getCompanyFullDetails)
router.post('/send-company-mail', ownerTokenValidator, sendCompanyMail)
router.get('/preview-token/:companyId', ownerTokenValidator, getPreviewToken)

module.exports = router

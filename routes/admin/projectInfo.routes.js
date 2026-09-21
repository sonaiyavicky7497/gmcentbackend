const express = require('express')
const {
  addLogo,
  getLogo,
  addCompanyName,
  getCompanyName,
  addProjectName,
  getProjectName,
  updateCompanyName,
  updateProjectName,
  deleteRecord,
  getCounts,
  inactiveRecord,
} = require('../../controller/admin/projectInfo.controller.js')
const { adminTokenValidator } = require('../../middleware/auth.middleware.js')
const bodyTrimmer = require('../../middleware/bodyTrimmer.js')

const projectRoute = express.Router()

projectRoute.post('/addLogo', adminTokenValidator, addLogo)
projectRoute.post('/getLogo', adminTokenValidator, getLogo)

projectRoute.post('/addCompanyName', bodyTrimmer, adminTokenValidator, addCompanyName)
projectRoute.post('/getCompany', adminTokenValidator, getCompanyName)
projectRoute.put('/updateCompany', bodyTrimmer, adminTokenValidator, updateCompanyName)

projectRoute.post('/addProjectName', bodyTrimmer, adminTokenValidator, addProjectName)
projectRoute.post('/getProject', adminTokenValidator, getProjectName)
projectRoute.put('/updateProject', bodyTrimmer, adminTokenValidator, updateProjectName)

projectRoute.post('/deleteRecord', adminTokenValidator, deleteRecord)
projectRoute.post('/inactiveRecord', adminTokenValidator, inactiveRecord)

projectRoute.post('/getCounts', adminTokenValidator, getCounts)

module.exports = projectRoute

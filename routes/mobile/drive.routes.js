const express = require('express')
const multer = require('multer')
const { getMyFolders, uploadPhoto, getFolderFiles, getAllGoogleDriveFolders } = require('../../controller/mobile/drive.controller')
const { mobileTokenValidator, thirdPartyShield } = require('../../middleware/auth.middleware')  

const driveRoute = express.Router()

// Configure multer for file uploads  
const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true)
    } else {
      cb(new Error('Only image files are allowed'), false)
    }
  },
})

// Mobile Drive Routes
driveRoute.get('/google-drive/folders', thirdPartyShield, getAllGoogleDriveFolders) // Unauthenticated
driveRoute.get('/my-folders', mobileTokenValidator, getMyFolders)
driveRoute.post('/upload', mobileTokenValidator, upload.single('photo'), uploadPhoto)
driveRoute.get('/folder/:folderId/files', mobileTokenValidator, getFolderFiles)

module.exports = driveRoute

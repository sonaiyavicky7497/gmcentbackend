const dbConnect = require('../../utils/dbConnect')
const { now } = require('../../utils/utilities')
const mongoose = require('mongoose')
const DriveFile = require('../../models/DriveFile.model')
const DriveFolder = require('../../models/DriveFolder.model')
const DriveUpload = require('../../models/DriveUpload.model')
const SyncLog = require('../../models/SyncLog.model')
const { getOAuth2Client, uploadFile: uploadFileToDriveUtil } = require('../../utils/googleDrive')
const { assertEmployeeFolderUploadAccess } = require('../../utils/driveAssignmentPermission')
const multer = require('multer')

const storage = multer.memoryStorage()
const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
  },
})

const handleSingleFileUpload = (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (!err) return next()

    const isSizeLimit = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE'
    return res.status(400).json({
      status: false,
      msg: isSizeLimit ? 'File size must be less than 100MB' : err.message || 'Invalid upload request',
    })
  })
}

const uploadFileToDrive = async (req, res) => {
  try {
    // Admin JWT: req.user = { id: companyId, ... }
    // adminOrMobileTokenValidator mobile: req.user = { user: seatId, company: companyId }
    const companyId = req.user.id || req.user.company
    const seatId = req.user.user || null // null for admin uploads
    const { folderId } = req.body

    if (!req.file) {
      return res.status(400).json({ msg: 'No file uploaded' })
    }

    if (req.file.size === 0) {
      return res.status(400).json({ msg: 'Uploaded file is empty' })
    }

    if (!folderId) {
      return res.status(400).json({ msg: 'Folder ID is required' })
    }

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ msg: 'Invalid folder ID' })
    }

    await dbConnect()

    const folder = await DriveFolder.findOne({ _id: folderId, companyId })
    if (!folder) {
      return res.status(404).json({ msg: 'Folder not found' })
    }

    if (seatId) {
      try {
        await assertEmployeeFolderUploadAccess({
          companyId,
          employeeId: seatId,
          folderId,
        })
      } catch (accessError) {
        return res.status(accessError.statusCode || 403).json({
          status: false,
          msg: accessError.message || 'You do not have permission to upload',
        })
      }
    }

    const auth = await getOAuth2Client(companyId)
    const mimeType = req.file.mimetype || 'application/octet-stream'
    const fileName = req.file.originalname

    const googleFile = await uploadFileToDriveUtil(auth, folder.googleFolderId, fileName, mimeType, req.file.buffer)

    const file = await DriveFile.create({
      companyId,
      seatId,
      folderId,
      googleFileId: googleFile.id,
      fileName: googleFile.name,
      fileUrl: googleFile.webViewLink,
      mimeType: googleFile.mimeType,
      fileSize: googleFile.size,
      uploadedAt: now(),
      isDeleted: false,
    })

    if (seatId) {
      await DriveUpload.create({
        employeeId: seatId,
        companyId,
        folderId,
        googleFolderId: folder.googleFolderId,
        googleFileId: googleFile.id,
        fileName: googleFile.name,
        fileUrl: googleFile.webViewLink,
        uploadedAt: now(),
      })
    }

    await SyncLog.create({
      companyId,
      actionType: 'file_upload',
      googleFileId: googleFile.id,
      folderId,
      seatId,
      status: 'success',
      message: `File "${fileName}" uploaded successfully`,
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'File uploaded successfully', file })
  } catch (err) {
    console.log('❌ uploadFileToDrive', err)
    const message = err?.message || 'Something went wrong'
    if (message.includes('Google Drive not connected')) {
      return res.status(400).json({ status: false, msg: message })
    }
    return res.status(500).json({ status: false, msg: message })
  }
}

const employeeUploadFile = async (req, res) => {
  try {
    const { company, user: seatId } = req.user
    const { folderId } = req.body

    if (!req.file) {
      return res.status(400).json({ msg: 'No file uploaded' })
    }

    if (req.file.size === 0) {
      return res.status(400).json({ msg: 'Uploaded file is empty' })
    }

    if (!folderId) {
      return res.status(400).json({ msg: 'Folder ID is required' })
    }

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ msg: 'Invalid folder ID' })
    }

    await dbConnect()

    const folder = await DriveFolder.findOne({ _id: folderId, companyId: company })
    if (!folder) {
      return res.status(404).json({ msg: 'Folder not found' })
    }

    try {
      await assertEmployeeFolderUploadAccess({
        companyId: company,
        employeeId: seatId,
        folderId,
      })
    } catch (accessError) {
      return res.status(accessError.statusCode || 403).json({
        status: false,
        msg: accessError.message || 'You do not have permission to upload',
      })
    }

    const auth = await getOAuth2Client(company)
    const mimeType = req.file.mimetype || 'application/octet-stream'
    const fileName = req.file.originalname

    const googleFile = await uploadFileToDriveUtil(auth, folder.googleFolderId, fileName, mimeType, req.file.buffer)

    const file = await DriveFile.create({
      companyId: company,
      seatId,
      folderId,
      googleFileId: googleFile.id,
      fileName: googleFile.name,
      fileUrl: googleFile.webViewLink,
      mimeType: googleFile.mimeType,
      fileSize: googleFile.size,
      uploadedAt: now(),
      isDeleted: false,
    })

    await DriveUpload.create({
      employeeId: seatId,
      companyId: company,
      folderId,
      googleFolderId: folder.googleFolderId,
      googleFileId: googleFile.id,
      fileName: googleFile.name,
      fileUrl: googleFile.webViewLink,
      uploadedAt: now(),
    })

    await SyncLog.create({
      companyId: company,
      actionType: 'file_upload',
      googleFileId: googleFile.id,
      folderId,
      seatId,
      status: 'success',
      message: `File "${fileName}" uploaded by employee`,
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'File uploaded successfully', file })
  } catch (err) {
    console.log('❌ employeeUploadFile', err)
    const message = err?.message || 'Something went wrong'
    if (message.includes('Google Drive not connected')) {
      return res.status(400).json({ status: false, msg: message })
    }
    return res.status(500).json({ status: false, msg: message })
  }
}

const uploadDriveManagerFile = async (req, res) => {
  try {
    const companyId = req.user.id || req.user.company
    const { folderId } = req.body // This is the Google folder ID now

    if (!req.file) {
      return res.status(400).json({ msg: 'No file uploaded' })
    }
    if (req.file.size === 0) {
      return res.status(400).json({ msg: 'Uploaded file is empty' })
    }
    if (!folderId) {
      return res.status(400).json({ msg: 'Folder ID is required' })
    }

    const auth = await getOAuth2Client(companyId)
    const mimeType = req.file.mimetype || 'application/octet-stream'
    const fileName = req.file.originalname

    const googleFile = await uploadFileToDriveUtil(auth, folderId, fileName, mimeType, req.file.buffer)

    // Refresh parent folder statistics
    try {
      const { google } = require('googleapis')
      const drive = google.drive({ version: 'v3', auth: auth })

      // Get child folders count
      const foldersResponse = await drive.files.list({
        q: `'${folderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      })
      const subfolderCount = (foldersResponse.data.files || []).length

      // Get files count
      const filesResponse = await drive.files.list({
        q: `'${folderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
        fields: 'files(id)',
      })
      const fileCount = (filesResponse.data.files || []).length

      // Update folder statistics in database
      await DriveFolder.findOneAndUpdate(
        { googleFolderId: folderId, companyId },
        {
          subfolderCount,
          fileCount,
          updatedAt: now(),
        },
      )
      console.log(`✅ Refreshed statistics for folder ${folderId}:`, { subfolderCount, fileCount })
    } catch (error) {
      console.log('⚠️ Failed to refresh folder statistics:', error.message)
    }

    return res.status(200).json({ status: true, msg: 'File uploaded successfully', file: googleFile })
  } catch (err) {
    console.log('❌ uploadDriveManagerFile', err)
    const message = err?.message || 'Something went wrong'
    return res.status(500).json({ status: false, msg: message })
  }
}

module.exports = {
  uploadFileToDrive,
  employeeUploadFile,
  uploadDriveManagerFile,
  upload,
  handleSingleFileUpload,
}
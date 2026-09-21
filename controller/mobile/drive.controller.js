// const DriveFolder = require('../../models/DriveFolder.model')
const FolderAssignment = require('../../models/FolderAssignment.model')
const DriveUpload = require('../../models/DriveUpload.model')
// const DriveSettings = require('../../models/DriveSettings.model')
const { getOAuth2Client, uploadFile, listFilesInFolder } = require('../../utils/googleDrive')
const { assertEmployeeFolderUploadAccess } = require('../../utils/driveAssignmentPermission')
const dbConnect = require('../../utils/dbConnect')
const { now } = require('../../utils/utilities')

// GET /api/google-drive/folders (unauthenticated)
const getAllGoogleDriveFolders = async (req, res) => {
  try {
    await dbConnect()
    const DriveSettings = require('../../models/DriveSettings.model')
    const { getOAuth2Client } = require('../../utils/googleDrive')
    const { google } = require('googleapis')

    // Find a connected Drive account to use for API access
    const settings = await DriveSettings.findOne({ isConnected: true }).lean()
    
    if (!settings) {
      return res.status(404).json({
        success: false,
        msg: 'No connected Google Drive account found',
      })
    }

    const auth = await getOAuth2Client(settings.companyId)
    const drive = google.drive({ version: 'v3', auth })
    
    const response = await drive.files.list({
      q: "mimeType = 'application/vnd.google-apps.folder' and trashed = false",
      fields: 'files(id, name)',
      pageSize: 1000,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })

    const folders = response.data.files.map((file) => ({
      _id: file.id,
      folderName: file.name,
      googleFolderId: file.id,
    }))

    return res.status(200).json({
      success: true,
      folders,
    })
  } catch (err) {
    console.error('❌ getAllGoogleDriveFolders error:', err)
    return res.status(500).json({
      success: false,
      msg: 'Failed to fetch folders',
    })
  }
}

// GET /api/mobile/drive/my-folders - Get assigned folders for logged-in employee
const getMyFolders = async (req, res) => {
  try {
    const seatId = req.user.user
    const companyId = req.user.company

    await dbConnect()

    const assignments = await FolderAssignment.find({
      companyId,
      employeeId: seatId,
    })
      .populate('folderId')
      .lean()

    const folders = assignments.map((assignment) => ({
      _id: assignment.folderId._id,
      folderName: assignment.folderId.folderName,
      googleFolderId: assignment.folderId.googleFolderId,
      webViewLink: assignment.folderId.webViewLink,
    }))

    return res.status(200).json({
      status: true,
      folders,
      count: folders.length,
    })
  } catch (err) {
    console.error('❌ getMyFolders error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Failed to fetch folders',
    })
  }
}

// POST /api/mobile/drive/upload - Upload photo to selected folder
const uploadPhoto = async (req, res) => {
  try {
    const seatId = req.user.user
    const companyId = req.user.company
    const { folderId, imageCode, imageDetails } = req.body
    const photo = req.file

    if (!photo) {
      return res.status(400).json({
        status: false,
        msg: 'Photo file is required',
      })
    }

    if (!folderId) {
      return res.status(400).json({
        status: false,
        msg: 'Folder ID is required',
      })
    }

    // Validate imageCode is required
    if (!imageCode) {
      return res.status(400).json({
        status: false,
        msg: 'Image code is required',
      })
    }

    await dbConnect()

    // Validate Image Code before upload
    const ImageCode = require('../../models/ImageCode.model')
    const imageCodeRecord = await ImageCode.findOne({ code: imageCode }).lean()

    if (!imageCodeRecord) {
      return res.status(404).json({
        status: false,
        msg: 'Invalid image code',
      })
    }

    // Check if code is expired
    if (imageCodeRecord.expiresAt && imageCodeRecord.expiresAt < now()) {
      return res.status(400).json({
        status: false,
        msg: 'Image code has expired. Please generate a new code.',
      })
    }

    // Check if code is already used
    // if (imageCodeRecord.isUsed) {
    //   return res.status(400).json({
    //     status: false,
    //     msg: 'This image code has already been used. Please generate a new code.',
    //   })
    // }

    // Verify code belongs to current user session
    if (imageCodeRecord.seatId && imageCodeRecord.seatId.toString() !== seatId.toString()) {
      return res.status(403).json({
        status: false,
        msg: 'This image code belongs to a different user session.',
      })
    }

    // Verify code belongs to current company
    if (imageCodeRecord.companyId && imageCodeRecord.companyId.toString() !== companyId.toString()) {
      return res.status(403).json({
        status: false,
        msg: 'This image code belongs to a different company. Please switch to that company or generate a new code.',
      })
    }

    try {
      await assertEmployeeFolderUploadAccess({
        companyId,
        employeeId: seatId,
        folderId,
      })
    } catch (accessError) {
      return res.status(accessError.statusCode || 403).json({
        status: false,
        msg: accessError.message || 'You do not have access to this folder',
      })
    }

    const assignment = await FolderAssignment.findOne({
      companyId,
      employeeId: seatId,
      folderId,
    })
      .populate('folderId')
      .populate('employeeId')
      .lean()

    // Get Admin's OAuth credentials
    const auth = await getOAuth2Client(companyId)

    // Upload to Google Drive
    const googleFile = await uploadFile(auth, assignment.folderId.googleFolderId, photo.originalname, photo.mimetype, photo.buffer)

    // Check if image details already exist for this imageCode
    let existingImageDetails = null
    if (imageCode) {
      const ImageCode = require('../../models/ImageCode.model')
      const imageCodeRecord = await ImageCode.findOne({ code: imageCode }).lean()
      if (imageCodeRecord && imageCodeRecord.imageDetails) {
        existingImageDetails = imageCodeRecord.imageDetails
      }
    }

    // Prepare upload data
    const uploadData = {
      employeeId: seatId,
      companyId,
      folderId,
      googleFolderId: assignment.folderId.googleFolderId,
      googleFileId: googleFile.id,
      fileName: googleFile.name,
      fileUrl: googleFile.webViewLink,
      uploadedAt: now(),
      fileSize: photo.size || googleFile.size || 0,
      mimeType: photo.mimetype || googleFile.mimeType || 'image/jpeg',
      imageCode: imageCode, // Set the required imageCode
    }

    // Sync image details - prioritize request body, fallback to existing
    const details = imageDetails || existingImageDetails

    if (details) {
      // Basic Info
      uploadData.photoCode = details.pc || null
      uploadData.enterpriseCode = details.ec || null
      uploadData.firstName = details.fn || assignment.employeeId?.firstName || null
      uploadData.lastName = details.ln || assignment.employeeId?.lastName || null
      uploadData.email = details.em || null

      // Device Info
      uploadData.appVersion = details.av || null
      uploadData.deviceName = details.dn || null
      uploadData.os = details.os || null

      // Location Info
      uploadData.country = details.cty || null
      uploadData.city = details.ct || null
      uploadData.state = details.st || null
      uploadData.address = details.addr || null
      uploadData.plusCode = details.pcd || null

      // Parse latitude/longitude from ll field
      if (details.ll) {
        const [lat, lng] = details.ll.split(',').map((coord) => parseFloat(coord.trim()))
        uploadData.latitude = lat || null
        uploadData.longitude = lng || null
      }

      // Time Info
      uploadData.captureDate = details.cd || null
      uploadData.captureTime = details.tm || null
      uploadData.timezone = details.tz || null

      // Camera Settings
      uploadData.ratio = details.rt || null
      uploadData.mirror = details.mir || null
      uploadData.cameraSide = details.cs || null
      uploadData.stampOnPhoto = details.sop || null

      // Project Info
      uploadData.routeTag = details.rtag || null
      uploadData.mapType = details.mt || null
      uploadData.projectName = details.pn || null
      uploadData.companyName = details.cn || null

      // Additional Info
      uploadData.number = details.num || null
      uploadData.hashtag = details.nh || null
      uploadData.mobile = details.mob || null

      // Weather Info
      uploadData.weatherTemp = details.wt || null
      uploadData.compass = details.cmp || null
      uploadData.mapFormat = details.mf || null
      uploadData.wind = details.wnd || null
      uploadData.humidity = details.hum || null
      uploadData.pressure = details.prs || null
      uploadData.altitude = details.alt || null
      uploadData.accuracy = details.acc || null
      uploadData.sound = details.snd || null
      uploadData.magneticField = details.mf || null
      uploadData.reportingTag = details.rtag || null

      // Stamp Settings
      uploadData.stampPosition = details.stp || null
      uploadData.fontSize = details.fs || null
      uploadData.stampPlacement = details.sp || null
      uploadData.mapPosition = details.mp || null

      // Legacy fields
      uploadData.projectId = details.projectId || null
      uploadData.capturedAt = details.timestamp || details.capturedAt || null
    }

    // Use upsert logic: create or update based on imageCode
    let uploadRecord
    if (imageCode) {
      uploadRecord = await DriveUpload.findOneAndUpdate({ imageCode }, uploadData, { upsert: true, new: true, setDefaultsOnInsert: true })
    } else {
      uploadRecord = await DriveUpload.create(uploadData)
    }

    return res.status(200).json({
      status: true,
      msg: 'Photo uploaded successfully',
      file: {
        googleFileId: googleFile.id,
        fileName: googleFile.name,
        fileUrl: googleFile.webViewLink,
        imageCode: uploadRecord.imageCode,
        uploadedAt: uploadRecord.uploadedAt,
      },
    })
  } catch (err) {
    console.error('❌ uploadPhoto error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Failed to upload photo',
    })
  }
}

// GET /api/mobile/drive/folder/:folderId/files - Get files in folder
const getFolderFiles = async (req, res) => {
  try {
    const seatId = req.user.user
    const companyId = req.user.company
    const { folderId } = req.params

    await dbConnect()

    // Validate folder assignment
    const assignment = await FolderAssignment.findOne({
      companyId,
      employeeId: seatId,
      folderId,
    })
      .populate('folderId')
      .lean()

    if (!assignment) {
      return res.status(403).json({
        status: false,
        msg: 'You do not have access to this folder',
      })
    }

    // Get Admin's OAuth credentials
    const auth = await getOAuth2Client(companyId)

    // Fetch files from Google Drive
    const driveFiles = await listFilesInFolder(auth, assignment.folderId.googleFolderId)

    const files = driveFiles.map((file) => ({
      fileId: file.id,
      fileName: file.name,
      webViewLink: file.webViewLink,
      thumbnailLink: file.thumbnailLink,
    }))

    return res.status(200).json({
      status: true,
      files,
      count: files.length,
    })
  } catch (err) {
    console.error('❌ getFolderFiles error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Failed to fetch files',
    })
  }
}

module.exports = {
  getMyFolders,
  uploadPhoto,
  getFolderFiles,
  getAllGoogleDriveFolders,
}
const { google } = require('googleapis')
const dbConnect = require('../../utils/dbConnect')
const { now } = require('../../utils/utilities')
const mongoose = require('mongoose')
const DriveFile = require('../../models/DriveFile.model')
const DriveFolder = require('../../models/DriveFolder.model')
const DriveSettings = require('../../models/DriveSettings.model')
const FolderAssignment = require('../../models/FolderAssignment.model')
const DriveUpload = require('../../models/DriveUpload.model')
const SyncLog = require('../../models/SyncLog.model')
const Seat = require('../../models/Seat.model')
const {
  getOAuth2Client,
  // uploadFile: uploadFileToDrive,
  createFolder: createDriveFolder,
  deleteFile: deleteDriveFile,
  renameFile: renameDriveFile,
  moveFile: moveDriveFile,
  listFilesInFolder,
  listAllFolders,
  makeFolderShareable,
  getFile,
  downloadFile: downloadDriveFile,
  shareWithUser,
  updateFolderPermission,
  listFolderPermissions,
  removeFolderPermission,
} = require('../../utils/googleDrive')
const driveManager = require('../../services/driveManager.service')
const driveReconcile = require('../../services/driveReconcile.service')
const drivePermissionReconcile = require('../../services/drivePermissionReconcile.service')

const DRIVE_ASSIGNMENT_ROLES = ['reader', 'commenter', 'writer']

const normalizeAssignmentRole = (role) => {
  const normalized = String(role || 'reader').toLowerCase()
  if (['viewer', 'view'].includes(normalized)) return 'reader'
  if (['commenter', 'comment'].includes(normalized)) return 'commenter'
  if (['editor', 'edit', 'writer'].includes(normalized)) return 'writer'
  return DRIVE_ASSIGNMENT_ROLES.includes(normalized) ? normalized : 'reader'
}

// Recursive delete utility function
const deleteFolderRecursively = async (googleFolderId, companyId, auth) => {
  console.log('🗑️ Starting recursive delete for folder:', googleFolderId)
  
  const drive = google.drive({ version: 'v3', auth: auth })
  const deletedItems = {
    folders: [],
    files: [],
    assignments: [],
  }

  try {
    // Step 1: Get all child folders
    const foldersResponse = await drive.files.list({
      q: `'${googleFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    })

    const childFolders = foldersResponse.data.files || []
    console.log(`📁 Found ${childFolders.length} child folders`)

    // Step 2: Recursively delete each child folder
    for (const childFolder of childFolders) {
      console.log(`📂 Recursively deleting child folder: ${childFolder.name} (${childFolder.id})`)
      const childResult = await deleteFolderRecursively(childFolder.id, companyId, auth)
      deletedItems.folders.push(...childResult.folders)
      deletedItems.files.push(...childResult.files)
      deletedItems.assignments.push(...childResult.assignments)
    }

    // Step 3: Get all files in this folder
    const filesResponse = await drive.files.list({
      q: `'${googleFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id, name)',
    })

    const files = filesResponse.data.files || []
    console.log(`📄 Found ${files.length} files in folder`)

    // Step 4: Delete all files from Google Drive
    for (const file of files) {
      try {
        await drive.files.delete({ fileId: file.id })
        console.log(`✅ Deleted file: ${file.name} (${file.id})`)
        deletedItems.files.push(file.id)
      } catch (error) {
        console.log(`⚠️ Failed to delete file ${file.name}:`, error.message)
      }
    }

    // Step 5: Delete all assignments for this folder and its children from database
    const allFolderIds = [googleFolderId, ...deletedItems.folders]
    const assignmentDeleteResult = await FolderAssignment.deleteMany({
      companyId,
      googleFolderId: { $in: allFolderIds },
    })
    console.log(`🗑️ Deleted ${assignmentDeleteResult.deletedCount} assignments from database`)
    deletedItems.assignments.push(...allFolderIds)

    // Step 6: Delete all DriveUpload records for this folder and its children
    const uploadDeleteResult = await DriveUpload.deleteMany({
      companyId,
      googleFolderId: { $in: allFolderIds },
    })
    console.log(`🗑️ Deleted ${uploadDeleteResult.deletedCount} upload records from database`)

    // Step 7: Delete all DriveFile records for this folder and its children
    const fileDeleteResult = await DriveFile.deleteMany({
      companyId,
      googleFolderId: { $in: allFolderIds },
    })
    console.log(`🗑️ Deleted ${fileDeleteResult.deletedCount} file records from database`)

    // Step 8: Delete the folder itself from Google Drive
    await drive.files.delete({ fileId: googleFolderId })
    console.log(`✅ Deleted folder from Google Drive: ${googleFolderId}`)
    deletedItems.folders.push(googleFolderId)

    // Step 9: Delete the folder from DriveFolder database
    const folderDeleteResult = await DriveFolder.deleteOne({
      companyId,
      googleFolderId,
    })
    console.log(`🗑️ Deleted folder from database: ${googleFolderId}`)

    console.log(`✅ Recursive delete complete for ${googleFolderId}`)
    return deletedItems
  } catch (error) {
    console.log(`❌ Error in recursive delete for ${googleFolderId}:`, error.message)
    throw error
  }
}

// Utility to refresh folder statistics recursively
const refreshFolderStatistics = async (googleFolderId, companyId, auth) => {
  console.log('🔄 Refreshing folder statistics for:', googleFolderId)
  
  const drive = google.drive({ version: 'v3', auth: auth })
  
  try {
    // Get child folders count
    const foldersResponse = await drive.files.list({
      q: `'${googleFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    })
    const subfolderCount = (foldersResponse.data.files || []).length

    // Get files count
    const filesResponse = await drive.files.list({
      q: `'${googleFolderId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)',
    })
    const fileCount = (filesResponse.data.files || []).length

    // Get assignments count
    const assignmentCount = await FolderAssignment.countDocuments({
      companyId,
      googleFolderId,
    })

    // Update folder statistics in database
    const updateResult = await DriveFolder.findOneAndUpdate(
      { companyId, googleFolderId },
      {
        subfolderCount,
        fileCount,
        assignmentCount,
        updatedAt: now(),
      },
      { new: true }
    )

    console.log(`✅ Refreshed statistics for ${googleFolderId}:`, {
      subfolderCount,
      fileCount,
      assignmentCount,
    })

    return updateResult
  } catch (error) {
    console.log(`❌ Error refreshing statistics for ${googleFolderId}:`, error.message)
    throw error
  }
}

const formatAssignment = (assignment) => ({
  ...assignment,
  folderName: assignment.folderId?.folderName || null,
  driveFolderId: assignment.driveFolderId || assignment.folderId?.googleFolderId || null,
  folderWebViewLink: assignment.folderId?.folderLink || null,
  employeeName: assignment.seatId ? `${assignment.seatId.fname || ''} ${assignment.seatId.lname || ''}`.trim() : null,
  employeeEmail: assignment.employeeEmail || assignment.seatId?.email || null,
  role: assignment.permissionRole || 'reader',
})

// Helper function to fetch user info using direct HTTP request (fallback)
const fetchUserInfoDirect = async (accessToken) => {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  })
  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status} ${response.statusText}`)
  }
  return await response.json()
}

const SCOPES = [
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'openid'
]

const getOAuthUrl = async (req, res) => {
  try {
    const { id: companyId } = req.user
    console.log('🔑 OAuth URL Request - Company ID:', companyId)
    await dbConnect()

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    )
    console.log('🔐 OAuth URL Request - Client ID:', process.env.GOOGLE_CLIENT_ID)
    console.log('🔗 OAuth URL Request - Redirect URI:', process.env.GOOGLE_REDIRECT_URI)

    const authUrl = oauth2Client.generateAuthUrl({
      access_type: 'offline',
      scope: SCOPES,
      prompt: 'consent',
      state: companyId.toString(),
    })
    console.log('✅ OAuth URL Request - Auth URL generated successfully')

    return res.status(200).json({ status: true, authUrl })
  } catch (err) {
    console.log('❌ getOAuthUrl Error:', err.message)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const handleOAuthCallback = async (req, res) => {
  try {
    const { code, state } = req.query
    console.log('🔑 OAuth Callback - Query params:', { code: code ? 'RECEIVED' : 'MISSING', state: state ? 'RECEIVED' : 'MISSING' })
    
    if (!code || !state) {
      console.log('❌ OAuth Callback - Missing required parameters')
      return res.status(400).json({ msg: 'Missing required parameters' })
    }

    const companyId = state
    console.log('🏢 OAuth Callback - Company ID:', companyId)
    await dbConnect()

    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    )
    console.log('🔐 OAuth Callback - Client ID:', process.env.GOOGLE_CLIENT_ID)
    console.log('🔗 OAuth Callback - Redirect URI:', process.env.GOOGLE_REDIRECT_URI)

    const { tokens } = await oauth2Client.getToken(code)
    console.log('✅ OAuth Callback - Tokens received:', {
      hasAccessToken: !!tokens.access_token,
      hasRefreshToken: !!tokens.refresh_token,
      tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : 'N/A',
      scope: tokens.scope
    })
    
    oauth2Client.setCredentials(tokens)
    console.log('🔑 OAuth Callback - Credentials set on OAuth2 client')

    // Verify credentials are set
    console.log('🔍 OAuth Callback - Verifying OAuth2 client credentials:', {
      hasAccessToken: !!oauth2Client.credentials.access_token,
      hasRefreshToken: !!oauth2Client.credentials.refresh_token,
      tokenExpiry: oauth2Client.credentials.expiry_date ? new Date(oauth2Client.credentials.expiry_date).toISOString() : 'N/A'
    })

    let userInfo
    try {
      console.log('📡 OAuth Callback - Attempting to fetch user info via google.oauth2 API')
      const oauth2 = google.oauth2('v2')
      userInfo = await oauth2.userinfo.get({ auth: oauth2Client })
      console.log('✅ OAuth Callback - User info fetched via google.oauth2 API:', {
        email: userInfo.data.email,
        name: userInfo.data.name,
        id: userInfo.data.id
      })
    } catch (apiError) {
      console.log('⚠️ OAuth Callback - google.oauth2 API failed, trying direct HTTP request')
      console.log('⚠️ OAuth Callback - API Error:', apiError.message)
      
      // Fallback: Use direct HTTP request with access token
      console.log('📡 OAuth Callback - Attempting to fetch user info via direct HTTP request')
      userInfo = await fetchUserInfoDirect(tokens.access_token)
      console.log('✅ OAuth Callback - User info fetched via direct HTTP request:', {
        email: userInfo.email,
        name: userInfo.name,
        id: userInfo.id
      })
    }

    const existingSettings = await DriveSettings.findOne({ companyId })
    console.log('🔍 OAuth Callback - Checking existing settings:', existingSettings ? 'FOUND' : 'NOT FOUND')
    
    // Handle different response structures from google.oauth2 API vs direct HTTP request
    const email = userInfo.data?.email || userInfo.email
    const name = userInfo.data?.name || userInfo.name
    const id = userInfo.data?.id || userInfo.id
    
    if (existingSettings) {
      console.log('🔄 OAuth Callback - Updating existing Drive settings')
      await DriveSettings.findOneAndUpdate(
        { companyId },
        {
          googleAccountEmail: email,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiry: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : null,
          scope: tokens.scope,
          isConnected: true,
          updatedAt: now(),
        }
      )
    } else {
      console.log('➕ OAuth Callback - Creating new Drive settings')
      await DriveSettings.create({
        companyId,
        googleAccountEmail: email,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiry: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : null,
        scope: tokens.scope,
        isConnected: true,
        createdAt: now(),
        updatedAt: now(),
      })
    }

    await SyncLog.create({
      companyId,
      actionType: 'oauth_connect',
      status: 'success',
      message: 'Google Drive connected successfully',
      syncedAt: now(),
    })
    console.log('📝 OAuth Callback - Sync log created')

    // Auto-create "GPS Map Camera ENT" folder
    try {
  console.log('📁 Checking if "GPS Map Camera ENT" folder already exists')

  const drive = google.drive({
    version: 'v3',
    auth: oauth2Client,
  })

  // STEP 1: Check Database First
  let existingFolder = await DriveFolder.findOne({
    companyId,
    folderName: 'GPS Map Camera ENT',
  })

  if (existingFolder) {
    console.log(
      '✅ Folder already exists in database:',
      existingFolder.googleFolderId
    )
  } else {
    // STEP 2: Check Google Drive
    const existingGoogleFolder = await drive.files.list({
      q: `
        name='GPS Map Camera ENT'
        and mimeType='application/vnd.google-apps.folder'
        and trashed=false
      `,
      fields: 'files(id,name,webViewLink)',
      spaces: 'drive',
    })

    if (
      existingGoogleFolder.data.files &&
      existingGoogleFolder.data.files.length > 0
    ) {
      const folder = existingGoogleFolder.data.files[0]

      console.log(
        '✅ Folder already exists in Google Drive:',
        folder.id
      )

      await DriveFolder.create({
        companyId,
        googleFolderId: folder.id,
        folderName: folder.name,
        webViewLink: folder.webViewLink || null,
        createdAt: now(),
      })

      console.log(
        '✅ Existing Google folder synced to database'
      )
    } else {
      // STEP 3: Create New Folder
      console.log(
        '📁 Folder not found. Creating new "GPS Map Camera ENT" folder'
      )

      const folderResponse = await drive.files.create({
        requestBody: {
          name: 'GPS Map Camera ENT',
          mimeType: 'application/vnd.google-apps.folder',
        },
        fields: 'id,webViewLink',
      })

      const googleFolderId = folderResponse.data.id
      const webViewLink = folderResponse.data.webViewLink

      console.log('✅ Folder created:', {
        googleFolderId,
        webViewLink,
      })

      await DriveFolder.create({
        companyId,
        googleFolderId,
        folderName: 'GPS Map Camera ENT',
        webViewLink,
        createdAt: now(),
      })

      console.log(
        '✅ New folder saved in database'
      )
    }
  }
} catch (folderError) {
  console.log(
    '⚠️ Folder creation check failed:',
    folderError.message
  )
}

    console.log('✅ OAuth Callback - Redirecting to frontend with success')
    res.redirect(`${process.env.FRONTEND_URI}/google-drive?connected=true`)
  } catch (err) {
    console.log('❌ handleOAuthCallback Error:', err.message)
    console.log('❌ handleOAuthCallback Stack:', err.stack)
    res.redirect(`${process.env.FRONTEND_URI}/google-drive?connected=false`)
  }
}

const getConnectionStatus = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    const settings = await DriveSettings.findOne({ companyId }).lean()
    if (!settings) {
      return res.status(200).json({ status: true, connected: false })
    }

    return res.status(200).json({
      status: true,
      connected: settings.isConnected,
      googleAccountEmail: settings.googleAccountEmail,
    })
  } catch (err) {
    console.log('❌ getConnectionStatus', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const disconnectDrive = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    await DriveSettings.findOneAndUpdate(
      { companyId },
      {
        accessToken: null,
        refreshToken: null,
        tokenExpiry: null,
        isConnected: false,
        updatedAt: now(),
      }
    )

    await SyncLog.create({
      companyId,
      actionType: 'oauth_disconnect',
      status: 'success',
      message: 'Google Drive disconnected',
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'Google Drive disconnected successfully' })
  } catch (err) {
    console.log('❌ disconnectDrive', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const createFolder = async (req, res) => {
  try {
    const { id: companyId, id: adminSeatId } = req.user
    const { folderName, folderDescription } = req.body
    if (!folderName) {
      return res.status(400).json({ msg: 'Folder name is required' })
    }

    await dbConnect()

    const auth = await getOAuth2Client(companyId)
    const googleFolder = await createDriveFolder(auth, folderName)
    const folderLink = await makeFolderShareable(auth, googleFolder.id)

    const folder = await DriveFolder.create({
      companyId,
      folderName,
      folderDescription,
      googleFolderId: googleFolder.id,
      folderLink,
      createdByAdminSeatId: adminSeatId,
      status: 'active',
      createdAt: now(),
    })

    await SyncLog.create({
      companyId,
      actionType: 'folder_create',
      googleFolderId: googleFolder.id,
      folderId: folder._id,
      seatId: adminSeatId,
      status: 'success',
      message: `Folder "${folderName}" created`,
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'Folder created successfully', folder })
  } catch (err) {
    console.log('❌ createFolder', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const listFolders = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await driveReconcile.reconcileCompanyDriveFolders(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ listFolders reconcile warning:', reconcileError.message)
    }
 
    const folders = await DriveFolder.find({ companyId, status: 'active' }).lean()
 
    const foldersWithStats = await Promise.all(
      folders.map(async (folder) => {
        const assignmentCount = await FolderAssignment.countDocuments({
          folderId: folder._id,
        })
        const fileCount = await DriveFile.countDocuments({
          folderId: folder._id,
          isDeleted: false,
        })
        const subfolderCount = await DriveFolder.countDocuments({
          companyId,
          googleParentFolderId: folder.googleFolderId,
          status: 'active',
        })
        return {
          ...folder,
          assignmentCount,
          fileCount,
          subfolderCount,
        }
      })
    )
 
    return res.status(200).json({ status: true, folders: foldersWithStats })
  } catch (err) {
    console.log('❌ listFolders', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const listGoogleDriveFolders = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { parentFolderId, appCreatedOnly } = req.query
    
    console.log('📂 Google Drive Folders Request - Company ID:', companyId)
    console.log('📂 Google Drive Folders Request - Options:', { parentFolderId, appCreatedOnly })
    
    await dbConnect()

    const auth = await getOAuth2Client(companyId)
    console.log('✅ Google Drive Folders Request - OAuth2 client obtained')

    const options = {
      parentFolderId: parentFolderId || null,
      appCreatedOnly: appCreatedOnly === 'true',
    }

    const googleFolders = await listAllFolders(auth, options)
    console.log(`✅ Google Drive Folders Request - Fetched ${googleFolders.length} folders from Google Drive`)

    const formattedFolders = googleFolders.map(folder => ({
      id: folder.id,
      name: folder.name,
      webViewLink: folder.webViewLink,
      createdTime: folder.createdTime,
      owners: folder.owners,
      parents: folder.parents,
    }))

    console.log('📂 Google Drive Folders Request - Returning formatted folders')
    return res.status(200).json({ 
      status: true, 
      folders: formattedFolders,
      count: formattedFolders.length
    })
  } catch (err) {
    console.log('❌ listGoogleDriveFolders Error:', err.message)
    console.log('❌ listGoogleDriveFolders Stack:', err.stack)
    return res.status(500).json({ msg: 'Failed to fetch Google Drive folders' })
  }
}

const handleDriveError = (res, err, fallbackMessage = 'Something went wrong') => {
  console.log('Drive Manager Error:', err.message)
  return res.status(err.statusCode || 500).json({ status: false, msg: err.message || fallbackMessage })
}

const getDriveFolderContents = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId } = req.params
    const { pageToken, pageSize, search, sortBy, order, type } = req.query
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await driveReconcile.reconcileCompanyDriveFolders(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ getDriveFolderContents reconcile warning:', reconcileError.message)
    }
 
    const data = await driveManager.getFolderContents(companyId, folderId, {
      pageToken,
      pageSize,
      search,
      sortBy,
      order,
      type,
    })
 
    return res.status(200).json({ status: true, ...data })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to fetch folder contents')
  }
}

const getDriveFileDetails = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    await dbConnect()

    const file = await driveManager.getFileDetails(companyId, fileId)
    return res.status(200).json({ status: true, file })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to fetch file details')
  }
}

const downloadDriveManagerFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    await dbConnect()

    const { file, stream } = await driveManager.downloadDriveItem(companyId, fileId)
    res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`)
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    stream.pipe(res)
  } catch (err) {
    return handleDriveError(res, err, 'Failed to download file')
  }
}

const renameDriveManagerFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    const { name, newName } = req.body
    const nextName = name || newName
    if (!nextName) {
      return res.status(400).json({ status: false, msg: 'New name is required' })
    }

    await dbConnect()
    const file = await driveManager.renameDriveItem(companyId, fileId, nextName)
    return res.status(200).json({ status: true, msg: 'Item renamed successfully', file })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to rename item')
  }
}

const moveDriveManagerFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    const { toFolderId, folderId } = req.body
    const targetFolderId = toFolderId || folderId
    if (!targetFolderId) {
      return res.status(400).json({ status: false, msg: 'Target folder ID is required' })
    }

    await dbConnect()
    const file = await driveManager.moveDriveItem(companyId, fileId, targetFolderId)
    return res.status(200).json({ status: true, msg: 'Item moved successfully', file })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to move item')
  }
}

const deleteDriveManagerFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    await dbConnect()

    await driveManager.deleteDriveItem(companyId, fileId)
    return res.status(200).json({ status: true, msg: 'Item deleted successfully' })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to delete item')
  }
}

const createDriveManagerFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { name, folderName, parentFolderId } = req.body
    const nextName = name || folderName
    if (!nextName) {
      return res.status(400).json({ status: false, msg: 'Folder name is required' })
    }

    await dbConnect()
    const folder = await driveManager.createDriveSubfolder(companyId, nextName, parentFolderId || null)
    
    // Refresh parent folder statistics if parent exists
    if (parentFolderId) {
      try {
        const auth = await getOAuth2Client(companyId)
        await refreshFolderStatistics(parentFolderId, companyId, auth)
      } catch (error) {
        console.log('⚠️ Failed to refresh parent folder statistics:', error.message)
      }
    }
    
    return res.status(200).json({ status: true, msg: 'Folder created successfully', folder })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to create folder')
  }
}

const renameDriveManagerFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId } = req.params
    const { name, folderName, toFolderId, parentFolderId } = req.body
    const nextName = name || folderName
    const targetFolderId = toFolderId || parentFolderId
    if (!nextName && !targetFolderId) {
      return res.status(400).json({ status: false, msg: 'Folder name or target folder ID is required' })
    }

    await dbConnect()
    const folder = targetFolderId
      ? await driveManager.moveDriveItem(companyId, folderId, targetFolderId)
      : await driveManager.renameDriveItem(companyId, folderId, nextName)
    return res.status(200).json({ status: true, msg: 'Folder updated successfully', folder })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to update folder')
  }
}

const deleteDriveManagerFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId } = req.params
    await dbConnect()
 
    const folder = await DriveFolder.findOne({ googleFolderId: folderId, companyId })
    const parentFolderId = folder?.googleParentFolderId
 
    const auth = await getOAuth2Client(companyId)
 
    // Delete from Google Drive first.
    await deleteDriveFile(auth, folderId)
 
    // Hard-purge MongoDB via the shared verified purge, if we had a
    // tracked DB record for it (manager-created subfolders are always
    // tracked via createDriveSubfolder, so this should normally exist).
    let purgeResult = { foldersDeleted: 0, filesDeleted: 0, uploadsDeleted: 0, assignmentsDeleted: 0 }
    if (folder) {
      purgeResult = await driveReconcile.purgeFolderTreeById(companyId, folder._id)
    }
 
    if (parentFolderId) {
      try {
        await refreshFolderStatistics(parentFolderId, companyId, auth)
      } catch (error) {
        console.log('⚠️ Failed to refresh parent folder statistics:', error.message)
      }
    }
 
    return res.status(200).json({
      status: true,
      msg: 'Folder and all contents deleted successfully',
      deletedItems: purgeResult,
      refresh: true,
      refreshedAt: now(),
    })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to delete folder')
  }
}

const shareDriveItem = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    const data = await driveManager.shareDriveItem(companyId, req.body)
    return res.status(200).json({ status: true, msg: 'Shared successfully', ...data })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to share item')
  }
}

const createPublicDriveLink = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId, role = 'reader' } = req.body
    if (!fileId) {
      return res.status(400).json({ status: false, msg: 'fileId is required' })
    }

    await dbConnect()
    const data = await driveManager.makePublicLink(companyId, fileId, role)
    return res.status(200).json({ status: true, msg: 'Public link generated', ...data })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to generate public link')
  }
}

const getDrivePermissions = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { fileId } = req.params
    await dbConnect()

    const permissions = await driveManager.getDrivePermissions(companyId, fileId)
    return res.status(200).json({ status: true, permissions })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to fetch permissions')
  }
}

const updateDrivePermission = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { permissionId } = req.params
    const { fileId, role } = req.body
    await dbConnect()

    const permission = await driveManager.updateDrivePermission(companyId, fileId, permissionId, role)
    return res.status(200).json({ status: true, msg: 'Permission updated', permission })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to update permission')
  }
}

const removeDrivePermission = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { permissionId } = req.params
    const fileId = req.query.fileId || req.body.fileId
    await dbConnect()

    await driveManager.removeDrivePermission(companyId, fileId, permissionId)
    return res.status(200).json({ status: true, msg: 'Permission removed' })
  } catch (err) {
    return handleDriveError(res, err, 'Failed to remove permission')
  }
}

const deleteFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    await dbConnect()
 
    const folder = await DriveFolder.findOne({ _id: id, companyId })
    if (!folder) {
      return res.status(404).json({ msg: 'Folder not found' })
    }
 
    if (folder.folderName === 'GPS Map Camera ENT') {
      console.log('❌ Attempted to delete protected folder:', folder.folderName)
      return res.status(403).json({
        status: false,
        msg: 'This folder is auto-created and protected. It cannot be deleted.'
      })
    }
 
    const auth = await getOAuth2Client(companyId)
 
    // 1. Delete from Google Drive — Drive recursively removes contents.
    console.log('🗑️ Deleting from Google Drive:', folder.folderName, folder.googleFolderId)
    await deleteDriveFile(auth, folder.googleFolderId)
 
    // 2. Hard-purge MongoDB using the shared, double-matched, verified
    //    purge function — guarantees zero leftover DriveFile/DriveUpload/
    //    FolderAssignment rows for this folder and every descendant.
    const purgeResult = await driveReconcile.purgeFolderTreeById(companyId, folder._id)
 
    console.log('✅ Cascade delete complete:', purgeResult)
 
    // 3. Refresh parent folder statistics if this had a parent
    if (folder.googleParentFolderId) {
      try {
        await refreshFolderStatistics(folder.googleParentFolderId, companyId, auth)
      } catch (error) {
        console.log('⚠️ Failed to refresh parent folder statistics:', error.message)
      }
    }
 
    await SyncLog.create({
      companyId,
      actionType: 'folder_delete',
      googleFolderId: folder.googleFolderId,
      folderId: folder._id,
      status: 'success',
      message: `Folder "${folder.folderName}" and all contents deleted (${purgeResult.foldersDeleted} folder(s), ${purgeResult.filesDeleted} file(s), ${purgeResult.uploadsDeleted} upload(s), ${purgeResult.assignmentsDeleted} assignment(s) removed)`,
      syncedAt: now(),
    })
 
    return res.status(200).json({
      status: true,
      msg: 'Folder and all contents deleted successfully',
      deletedItems: purgeResult,
      refresh: true,
      refreshedAt: now(),
    })
  } catch (err) {
    console.log('❌ deleteFolder', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const assignFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const assignedBySeatId = req.user.id
    // folderId from params (route: /folders/:id/assign), seatIds from body
    const folderId = req.params.id || req.body.folderId
    const { seatIds } = req.body

    console.log('📁 Assign Folder Request:', { folderId, seatIds, companyId })

    if (!folderId) {
      return res.status(400).json({ status: false, msg: 'Folder ID is required' })
    }
    if (!seatIds || !Array.isArray(seatIds)) {
      return res.status(400).json({ status: false, msg: 'seatIds array is required' })
    }

    await dbConnect()

    // Validate folder exists
    // folderId is the Google Drive folder ID (string), not a MongoDB ObjectId
    const folder = await DriveFolder.findOne({ googleFolderId: folderId, companyId })
    if (!folder) {
      return res.status(404).json({ status: false, msg: 'Folder not found' })
    }

    // Build desired state map: seatId -> role
    const desiredMap = {}
    for (const item of seatIds) {
      const seatId = (typeof item === 'object' ? item.seatId : item).toString()
      const role = normalizeAssignmentRole(typeof item === 'object' ? item.role : 'reader')
      desiredMap[seatId] = role
    }

    // Fetch existing assignments from DB
    const existingAssignments = await FolderAssignment.find({ companyId, folderId: folder._id }).lean()
    const existingMap = {}
    existingAssignments.forEach(a => { existingMap[a.employeeId.toString()] = a })

    // Get OAuth + current Drive permissions
    const auth = await getOAuth2Client(companyId)
    let drivePermissions = []
    try {
      drivePermissions = await listFolderPermissions(auth, folder.googleFolderId)
    } catch (e) {
      console.log('⚠️ Could not list Drive permissions:', e.message)
    }

    const results = []
    const errors = []

    // === CASE 1 & 3: Add or update employees in desired list ===
    for (const [seatId, role] of Object.entries(desiredMap)) {
      try {
        const employee = await Seat.findOne({ _id: seatId, companyId, status: 1 }).lean()
        if (!employee) { console.log('⚠️ Employee not found:', seatId); continue }

        const existing = existingMap[seatId]
        const drivePermission = drivePermissions.find(p => p.emailAddress === employee.email && !p.deleted)

        let permissionId = existing?.permissionId || drivePermission?.id
        let permissionChanged = existing && existing.permission !== role
        let isNew = !existing

        if (isNew) {
          // CASE 1: New assignment
          const perm = await shareWithUser(auth, folder.googleFolderId, employee.email, role, true)
          permissionId = perm.id
          await FolderAssignment.create({
            companyId,
            employeeId: seatId,
            employeeEmail: employee.email,
            folderId: folder._id,
            googleFolderId: folder.googleFolderId,
            folderName: folder.folderName,
            permission: role,
            permissionId,
            assignedBy: assignedBySeatId,
            assignedAt: now(),
            updatedAt: now(),
          })
          console.log(`✅ New assignment: ${employee.email} as ${role}`)
        } else if (permissionChanged) {
          // CASE 3: Permission changed
          if (permissionId) {
            const perm = await updateFolderPermission(auth, folder.googleFolderId, permissionId, role)
            permissionId = perm.id || permissionId
          } else {
            // fallback: try to find by email or create
            if (drivePermission) {
              const perm = await updateFolderPermission(auth, folder.googleFolderId, drivePermission.id, role)
              permissionId = perm.id || drivePermission.id
            } else {
              const perm = await shareWithUser(auth, folder.googleFolderId, employee.email, role, true)
              permissionId = perm.id
            }
          }
          await FolderAssignment.findByIdAndUpdate(existing._id, {
            permission: role,
            permissionId,
            updatedAt: now(),
          })
          console.log(`✅ Updated permission: ${employee.email} -> ${role}`)
        } else {
          // CASE 4: No change — make sure permissionId is stored if it was missing
          if (!existing.permissionId && permissionId) {
            await FolderAssignment.findByIdAndUpdate(existing._id, { permissionId, updatedAt: now() })
          }
          console.log(`ℹ️ No change: ${employee.email}`)
        }

        results.push({ success: true, email: employee.email, role, permissionId })
      } catch (err) {
        console.error(`❌ Error processing seatId ${seatId}:`, err.message)
        errors.push({ seatId, error: err.message })
      }
    }

    // === CASE 2: Remove employees NOT in desired list ===
    for (const [seatId, existing] of Object.entries(existingMap)) {
      if (desiredMap[seatId] !== undefined) continue // still wanted
      try {
        // Remove Drive permission
        let pid = existing.permissionId
        if (!pid) {
          // Fallback: find by email in Drive permissions
          const p = drivePermissions.find(dp => dp.emailAddress === existing.employeeEmail && !dp.deleted)
          pid = p?.id
        }
        if (pid) {
          await removeFolderPermission(auth, folder.googleFolderId, pid)
          console.log(`✅ Removed Drive permission for ${existing.employeeEmail}`)
        } else {
          console.log(`⚠️ No permissionId to remove for ${existing.employeeEmail}, skipping Drive call`)
        }
        // Remove DB assignment
        await FolderAssignment.findByIdAndDelete(existing._id)
        console.log(`✅ Removed assignment for ${existing.employeeEmail}`)
      } catch (err) {
        console.error(`❌ Error removing access for ${existing.employeeEmail}:`, err.message)
        errors.push({ email: existing.employeeEmail, error: err.message })
      }
    }

    try {
      await SyncLog.create({
        companyId,
        actionType: 'folder_assign',
        googleFolderId: folder.googleFolderId,
        folderId: folder._id,
        seatId: assignedBySeatId,
        status: errors.length === 0 ? 'success' : 'partial',
        message: `Assignment synced: ${results.length} OK${errors.length > 0 ? `, ${errors.length} failed` : ''}`,
        syncedAt: now(),
      })
    } catch (logErr) {
      console.log('⚠️ Could not create sync log:', logErr.message)
    }

    return res.status(200).json({
      status: true,
      msg: `Assignments updated successfully`,
      data: { success: results, errors, successCount: results.length, errorCount: errors.length },
    })
  } catch (err) {
    console.error('❌ assignFolder Error:', err.message, err.stack)
    return res.status(500).json({ status: false, msg: err.message || 'Failed to assign folder' })
  }
}

const unassignFolder = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    await dbConnect()

    const assignment = await FolderAssignment.findById(id).populate('folderId')
    if (!assignment || assignment.companyId.toString() !== companyId.toString()) {
      return res.status(404).json({ msg: 'Assignment not found' })
    }

    await FolderAssignment.findByIdAndDelete(id)

    await SyncLog.create({
      companyId,
      actionType: 'folder_unassign',
      folderId: assignment.folderId._id,
      seatId: assignment.seatId,
      status: 'success',
      message: 'Folder assignment revoked',
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'Folder unassigned successfully' })
  } catch (err) {
    console.log('❌ unassignFolder', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const listAssignments = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await drivePermissionReconcile.reconcileAllFolderPermissions(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ listAssignments permission reconcile warning:', reconcileError.message)
    }
 
    const assignments = await FolderAssignment.find({ companyId })
      .populate('employeeId', 'fname lname email')
      .populate('folderId', 'folderName folderLink googleFolderId')
      .populate('assignedBy', 'fname lname')
      .lean()
 
    // Normalize for frontend: flatten seatId alias
    const normalized = assignments.map(a => ({
      ...a,
      seatId: a.employeeId,
      permissionRole: a.permission || 'reader',
      folderWebViewLink: a.folderId?.folderLink || null,
    }))
 
    return res.status(200).json({ status: true, assignments: normalized })
  } catch (err) {
    console.log('❌ listAssignments', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const listFolderAssignments = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id: folderId } = req.params
    await dbConnect()
 
    const folder = await DriveFolder.findOne({ _id: folderId, companyId }).lean()
    if (!folder) return res.status(404).json({ status: false, msg: 'Folder not found' })
 
    try {
      const auth = await getOAuth2Client(companyId)
      await drivePermissionReconcile.reconcileFolderPermissions(companyId, folder, auth)
    } catch (reconcileError) {
      console.log('⚠️ listFolderAssignments permission reconcile warning:', reconcileError.message)
    }
 
    const assignments = await FolderAssignment.find({ companyId, folderId })
      .populate('employeeId', 'fname lname email')
      .lean()
 
    const data = assignments.map(a => ({
      _id: a._id,
      employeeId: a.employeeId?._id?.toString() || a.employeeId?.toString(),
      employeeName: a.employeeId ? `${a.employeeId.fname || ''} ${a.employeeId.lname || ''}`.trim() : '',
      employeeEmail: a.employeeEmail,
      permission: a.permission || 'reader',
      permissionId: a.permissionId || null,
      assignedAt: a.assignedAt,
      updatedAt: a.updatedAt,
    }))
 
    return res.status(200).json({ status: true, data })
  } catch (err) {
    console.log('❌ listFolderAssignments', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const listEmployeesForAssignment = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    const employees = await Seat.find({ companyId, status: 1 }, '_id fname lname email').lean()

    return res.status(200).json({ status: true, employees })
  } catch (err) {
    console.log('❌ listEmployeesForAssignment', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Photo reporting (DB first – no live Drive calls)
// ───────────────────────────────────────────────────────────────────────────────

const buildPhotoMatchFilter = (companyId, query = {}) => {
  const match = { companyId: new mongoose.Types.ObjectId(companyId) }

  if (query.projectId) {
    if (mongoose.Types.ObjectId.isValid(query.projectId)) {
      match.folderId = new mongoose.Types.ObjectId(query.projectId)
    }
  }
  if (query.employeeId) {
    if (mongoose.Types.ObjectId.isValid(query.employeeId)) {
      match.employeeId = new mongoose.Types.ObjectId(query.employeeId)
    }
  }

  if (query.dateFrom || query.dateTo) {
    match.uploadedAt = {}
    if (query.dateFrom) {
      const from = new Date(query.dateFrom)
      if (!isNaN(from.getTime())) {
        match.uploadedAt.$gte = Math.floor(from.getTime() / 1000)
      }
    }
    if (query.dateTo) {
      const to = new Date(query.dateTo)
      if (!isNaN(to.getTime())) {
        // include entire day
        to.setHours(23, 59, 59, 999)
        match.uploadedAt.$lte = Math.floor(to.getTime() / 1000)
      }
    }
    if (Object.keys(match.uploadedAt).length === 0) {
      delete match.uploadedAt
    }
  }

  // type filter is optional; for now treat it as a case-insensitive
  // substring match on file extension
  if (query.type) {
    const type = String(query.type).toLowerCase()
    match.fileName = { $regex: new RegExp(`\\.${type}$`, 'i') }
  }

  return match
}

const resolveUploaderSeatId = async (req, companyId, folder) => {
  // 1. Direct seat id from mobile/employee tokens
  if (req.user.user) return req.user.user
 
  // 2. Some admin JWTs carry the acting seat id under a different key —
  //    check common alternates before falling back.
  if (req.user.seatId) return req.user.seatId
  if (req.user.adminSeatId) return req.user.adminSeatId
 
  // 3. Fall back to whoever created/owns this folder in our DB, so the
  //    upload is still attributed to a real Seat and therefore still
  //    shows up in DriveUpload-based reporting.
  if (folder?.createdByAdminSeatId) return folder.createdByAdminSeatId
 
  return null
}
 
const uploadFileToDrive = async (req, res) => {
  try {
    // Admin JWT: req.user = { id: companyId, ... }
    // adminOrMobileTokenValidator mobile: req.user = { user: seatId, company: companyId }
    const companyId = req.user.id || req.user.company
    let seatId = req.user.user || null // null for admin uploads
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
 
    // Resolve who this upload should be attributed to for DriveUpload
    // purposes — needed even for admin uploads, since DriveUpload.employeeId
    // is a required field and is what every "All Photos" report reads from.
    const uploadAttributedSeatId = await resolveUploaderSeatId(req, companyId, folder)
 
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
 
    await DriveUpload.create({
      employeeId: uploadAttributedSeatId || null,
      companyId,
      folderId,
      googleFolderId: folder.googleFolderId,
      googleFileId: googleFile.id,
      fileName: googleFile.name,
      fileUrl: googleFile.webViewLink,
      uploadedAt: now(),
    })
 
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
 
    return res.status(200).json({ status: true, msg: 'File uploaded successfully', file, refresh: true, refreshedAt: now() })
  } catch (err) {
    console.log('❌ uploadFileToDrive', err)
    const message = err?.message || 'Something went wrong'
    if (message.includes('Google Drive not connected')) {
      return res.status(400).json({ status: false, msg: message })
    }
    return res.status(500).json({ status: false, msg: message })
  }
}


const backfillDriveUploadsFromDriveFiles = async (companyId) => {
  const files = await DriveFile.find(
    {
      companyId,
      isDeleted: false,
      mimeType: { $regex: /^image\//i },
    },
    'seatId folderId googleFileId fileName fileUrl uploadedAt'
  ).lean()
 
  if (!files.length) return
 
  const existingUploads = await DriveUpload.find(
    {
      companyId,
      googleFileId: { $in: files.map((file) => file.googleFileId) },
    },
    'googleFileId'
  ).lean()
 
  const existingIdSet = new Set(existingUploads.map((item) => item.googleFileId))
 
  const candidateFiles = files.filter((file) => !existingIdSet.has(file.googleFileId))
  if (!candidateFiles.length) return
 
  // Resolve folder -> createdByAdminSeatId once, so files with no seatId
  // (admin uploads, including ones uploaded before this fix) still get
  // attributed to a real Seat and therefore appear in reporting.
  const folderIds = [...new Set(candidateFiles.map((f) => String(f.folderId)))]
  const folders = await DriveFolder.find(
    { _id: { $in: folderIds } },
    '_id googleFolderId createdByAdminSeatId'
  ).lean()
  const folderMap = new Map(folders.map((folder) => [String(folder._id), folder]))
 
  const missingDocs = []
  for (const file of candidateFiles) {
    const folder = folderMap.get(String(file.folderId))
    const employeeId = file.seatId || folder?.createdByAdminSeatId || null
 
    // if (!employeeId) {
    //   console.log(
    //     `⚠️ backfillDriveUploadsFromDriveFiles: skipping file "${file.fileName}" — no employeeId and no createdByAdminSeatId on its folder, cannot backfill into DriveUpload.`
    //   )
    //   continue
    // }
 
    missingDocs.push({
      employeeId,
      companyId,
      folderId: file.folderId,
      googleFolderId: folder?.googleFolderId || '',
      googleFileId: file.googleFileId,
      fileName: file.fileName || 'uploaded-image',
      fileUrl: file.fileUrl || null,
      uploadedAt: file.uploadedAt || now(),
    })
  }
 
  if (!missingDocs.length) return
 
  try {
    await DriveUpload.insertMany(missingDocs, { ordered: false })
  } catch (err) {
    console.log('⚠️ backfillDriveUploadsFromDriveFiles insertMany error:', err.message)
  }
}

// GET /api/admin/drive/photos
const getCompanyPhotos = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const {
      page = 1,
      limit = 30,
      search,
      projectId,
      employeeId,
      dateFrom,
      dateTo,
      type,
    } = req.query
 
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await driveReconcile.reconcileCompanyDriveFolders(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ getCompanyPhotos reconcile warning:', reconcileError.message)
    }
 
    await backfillDriveUploadsFromDriveFiles(companyId)
 
    const pageNumber = Math.max(1, parseInt(page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const skip = (pageNumber - 1) * pageSize
 
    const match = buildPhotoMatchFilter(companyId, {
      projectId,
      employeeId,
      dateFrom,
      dateTo,
      type,
    })
 
    const pipeline = [
      { $match: match },
    ]
 
    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { fileName: { $regex: search, $options: 'i' } },
          ],
        },
      })
    }
 
    pipeline.push(
      { $sort: { uploadedAt: -1 } },
      {
        $lookup: {
          from: 'seats',
          localField: 'employeeId',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
      {
        $lookup: {
          from: 'drivefolders',
          localField: 'folderId',
          foreignField: '_id',
          as: 'folder',
        },
      },
      { $unwind: '$folder' },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: pageSize },
            {
              $project: {
                _id: 1,
                imageCode: 1,
                imageUrl: '$fileUrl',
                employeeId: 1,
                companyId: 1,
                folderId: 1,
                folderName: '$folder.folderName',
                uploadedAt: 1,
                fileName: 1,
                fileSize: 1,
                mimeType: 1,
                driveFileId: '$googleFileId',
                // Employee name from joined seats collection
                employeeName: {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: ['$employee.fname', ''] },
                        ' ',
                        { $ifNull: ['$employee.lname', ''] },
                      ],
                    },
                  },
                },
                // All 42 image details fields
                photoCode: 1,
                enterpriseCode: 1,
                firstName: 1,
                lastName: 1,
                email: 1,
                appVersion: 1,
                deviceName: 1,
                os: 1,
                country: 1,
                city: 1,
                state: 1,
                address: 1,
                latitude: 1,
                longitude: 1,
                plusCode: 1,
                captureDate: 1,
                captureTime: 1,
                timezone: 1,
                ratio: 1,
                mirror: 1,
                cameraSide: 1,
                stampOnPhoto: 1,
                routeTag: 1,
                mapType: 1,
                projectName: 1,
                companyName: 1,
                number: 1,
                hashtag: 1,
                mobile: 1,
                weatherTemp: 1,
                compass: 1,
                mapFormat: 1,
                wind: 1,
                humidity: 1,
                pressure: 1,
                altitude: 1,
                accuracy: 1,
                sound: 1,
                stampPosition: 1,
                fontSize: 1,
                stampPlacement: 1,
                mapPosition: 1,
                magneticField: 1,
                reportingTag: 1,
              },
            },
          ],
          totalCount: [{ $count: 'count' }],
        },
      },
    )
 
    const result = await DriveUpload.aggregate(pipeline)
    const docs = result[0] || { data: [], totalCount: [] }
    const totalPhotos = docs.totalCount[0]?.count || 0
 
    return res.status(200).json({
      status: true,
      totalPhotos,
      photos: docs.data,
      page: pageNumber,
      limit: pageSize,
    })
  } catch (err) {
    console.log('❌ getCompanyPhotos', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch photos' })
  }
}

// GET /api/admin/drive/photo/:id - Get single photo with complete details
const getPhotoDetails = async (req, res) => {
  try {
    const { id } = req.params

    await dbConnect()

    let photo = null
    if (mongoose.Types.ObjectId.isValid(id)) {
      photo = await DriveUpload.findOne({
        _id: new mongoose.Types.ObjectId(id),
      })
        .populate('folderId')
        .populate('employeeId')
        .lean()
    }

    if (!photo) {
      photo = await DriveUpload.findOne({
        googleFileId: id,
      })
        .populate('folderId')
        .populate('employeeId')
        .lean()
    }

    if (!photo) {
      return res.status(404).json({ status: false, msg: 'Photo not found' })
    }

    return res.status(200).json({
      status: true,
      photo: {
        _id: photo._id,
        imageCode: photo.imageCode || 'Not Available',
        driveFileId: photo.googleFileId,
        imageUrl: photo.fileUrl,
        employeeId: photo.employeeId,
        companyId: photo.companyId,
        folderId: photo.folderId,
        folderName: photo.folderName || photo.folderId?.folderName || 'Not Available',
        uploadedAt: photo.uploadedAt,
        fileName: photo.fileName,
        fileSize: photo.fileSize || 0,
        mimeType: photo.mimeType || 'image/jpeg',
        // All 42 image details fields
        photoCode: photo.photoCode || 'Not Available',
        enterpriseCode: photo.enterpriseCode || 'Not Available',
        firstName: photo.firstName || 'Not Available',
        lastName: photo.lastName || 'Not Available',
        email: photo.email || 'Not Available',
        appVersion: photo.appVersion || 'Not Available',
        deviceName: photo.deviceName || 'Not Available',
        os: photo.os || 'Not Available',
        country: photo.country || 'Not Available',
        city: photo.city || 'Not Available',
        state: photo.state || 'Not Available',
        address: photo.address || 'Not Available',
        latitude: photo.latitude || null,
        longitude: photo.longitude || null,
        plusCode: photo.plusCode || 'Not Available',
        captureDate: photo.captureDate || 'Not Available',
        captureTime: photo.captureTime || 'Not Available',
        timezone: photo.timezone || 'Not Available',
        ratio: photo.ratio || 'Not Available',
        mirror: photo.mirror || 'Not Available',
        cameraSide: photo.cameraSide || 'Not Available',
        stampOnPhoto: photo.stampOnPhoto || 'Not Available',
        routeTag: photo.routeTag || 'Not Available',
        mapType: photo.mapType || 'Not Available',
        projectName: photo.projectName || 'Not Available',
        companyName: photo.companyName || 'Not Available',
        number: photo.number || 'Not Available',
        hashtag: photo.hashtag || 'Not Available',
        mobile: photo.mobile || 'Not Available',
        weatherTemp: photo.weatherTemp || 'Not Available',
        compass: photo.compass || 'Not Available',
        mapFormat: photo.mapFormat || 'Not Available',
        wind: photo.wind || 'Not Available',
        humidity: photo.humidity || 'Not Available',
        pressure: photo.pressure || 'Not Available',
        altitude: photo.altitude || 'Not Available',
        accuracy: photo.accuracy || 'Not Available',
        sound: photo.sound || 'Not Available',
        stampPosition: photo.stampPosition || 'Not Available',
        fontSize: photo.fontSize || 'Not Available',
        stampPlacement: photo.stampPlacement || 'Not Available',
        mapPosition: photo.mapPosition || 'Not Available',
        magneticField: photo.magneticField || 'Not Available',
        reportingTag: photo.reportingTag || 'Not Available',
      },
    })
  } catch (err) {
    console.error('❌ getPhotoDetails error:', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch photo details' })
  }
}

// GET /api/admin/drive/photos/projects
const getCompanyPhotoProjects = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await driveReconcile.reconcileCompanyDriveFolders(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ getCompanyPhotoProjects reconcile warning:', reconcileError.message)
    }
 
    await backfillDriveUploadsFromDriveFiles(companyId)
 
    const pipeline = [
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
        },
      },
      {
        $group: {
          _id: '$folderId',
          photoCount: { $sum: 1 },
          latestUploadedAt: { $max: '$uploadedAt' },
          thumbnails: {
            $push: {
              imageUrl: '$fileUrl',
              uploadedAt: '$uploadedAt',
            },
          },
        },
      },
      {
        $lookup: {
          from: 'drivefolders',
          localField: '_id',
          foreignField: '_id',
          as: 'folder',
        },
      },
      // Folder no longer exists (already purged by reconcile, or any other
      // edge case) — drop it from results instead of crashing on $unwind.
      { $match: { folder: { $ne: [] } } },
      { $unwind: '$folder' },
      {
        $project: {
          _id: 0,
          folderId: '$_id',
          folderName: '$folder.folderName',
          photoCount: 1,
          latestPhoto: {
            uploadedAt: '$latestUploadedAt',
          },
          thumbnails: { $slice: ['$thumbnails', 3] },
        },
      },
      { $sort: { photoCount: -1, folderName: 1 } },
    ]
 
    const projects = await DriveUpload.aggregate(pipeline)
 
    return res.status(200).json({
      status: true,
      projects,
    })
  } catch (err) {
    console.log('❌ getCompanyPhotoProjects', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch project photos' })
  }
}

// GET /api/admin/drive/photos/project/:folderId
const getProjectPhotos = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId } = req.params
    const { page = 1, limit = 30, search, employeeId, dateFrom, dateTo, type } = req.query

    await dbConnect()
    await backfillDriveUploadsFromDriveFiles(companyId)

    if (!mongoose.Types.ObjectId.isValid(folderId)) {
      return res.status(400).json({ status: false, msg: 'Invalid project id' })
    }
    const folderObjectId = new mongoose.Types.ObjectId(folderId)

    // Ensure folder belongs to company (avoid cross-company leaks)
    const folder = await DriveFolder.findOne({ _id: folderObjectId, companyId }).lean()
    if (!folder) {
      return res.status(404).json({ status: false, msg: 'Project not found' })
    }

    const match = buildPhotoMatchFilter(companyId, {
      projectId: folderId,
      employeeId,
      dateFrom,
      dateTo,
      type,
    })

    const pageNumber = Math.max(1, parseInt(page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const skip = (pageNumber - 1) * pageSize

    const pipeline = [
      { $match: match },
    ]

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { fileName: { $regex: search, $options: 'i' } },
          ],
        },
      })
    }

    pipeline.push(
      { $sort: { uploadedAt: -1 } },
      {
        $lookup: {
          from: 'seats',
          localField: 'employeeId',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $unwind: { path: '$employee', preserveNullAndEmptyArrays: true } },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: pageSize },
            {
              $project: {
                _id: 0,
                imageUrl: '$fileUrl',
                employeeId: '$employeeId',
                employeeName: {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: ['$employee.fname', ''] },
                        ' ',
                        { $ifNull: ['$employee.lname', ''] },
                      ],
                    },
                  },
                },
                folderId: '$folderId',
                folderName: folder.folderName,
                companyId: '$companyId',
                uploadedAt: '$uploadedAt',
                createdAt: '$uploadedAt',
                driveFileId: '$googleFileId',
                fileName: '$fileName',
              },
            },
          ],
          totalCount: [{ $count: 'count' }],
        },
      },
    )

    const result = await DriveUpload.aggregate(pipeline)
    const docs = result[0] || { data: [], totalCount: [] }
    const totalPhotos = docs.totalCount[0]?.count || 0

    return res.status(200).json({
      status: true,
      project: {
        folderId: folder._id,
        folderName: folder.folderName,
      },
      totalPhotos,
      photos: docs.data,
      page: pageNumber,
      limit: pageSize,
    })
  } catch (err) {
    console.log('❌ getProjectPhotos', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch project photos' })
  }
}

// GET /api/admin/drive/photos/members
const getCompanyPhotoMembers = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()
 
    try {
      const auth = await getOAuth2Client(companyId)
      await driveReconcile.reconcileCompanyDriveFolders(companyId, auth)
    } catch (reconcileError) {
      console.log('⚠️ getCompanyPhotoMembers reconcile warning:', reconcileError.message)
    }
 
    await backfillDriveUploadsFromDriveFiles(companyId)
 
    const pipeline = [
      {
        $match: {
          companyId: new mongoose.Types.ObjectId(companyId),
        },
      },
      {
        $group: {
          _id: '$employeeId',
          photoCount: { $sum: 1 },
          lastUploadedAt: { $max: '$uploadedAt' },
          thumbnails: {
            $push: {
              imageUrl: '$fileUrl',
              uploadedAt: '$uploadedAt',
            },
          },
        },
      },
      {
        $lookup: {
          from: 'seats',
          localField: '_id',
          foreignField: '_id',
          as: 'employee',
        },
      },
      { $match: { employee: { $ne: [] } } },
      { $unwind: '$employee' },
      {
        $project: {
          _id: 0,
          employeeId: '$_id',
          employeeName: {
            $trim: {
              input: {
                $concat: [
                  { $ifNull: ['$employee.fname', ''] },
                  ' ',
                  { $ifNull: ['$employee.lname', ''] },
                ],
              },
            },
          },
          photoCount: 1,
          lastUpload: '$lastUploadedAt',
          thumbnails: { $slice: ['$thumbnails', 3] },
        },
      },
      { $sort: { photoCount: -1, employeeName: 1 } },
    ]
 
    const members = await DriveUpload.aggregate(pipeline)
 
    return res.status(200).json({
      status: true,
      members,
    })
  } catch (err) {
    console.log('❌ getCompanyPhotoMembers', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch member photos' })
  }
}

// GET /api/admin/drive/photos/member/:employeeId
const getMemberPhotos = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { employeeId } = req.params
    const { page = 1, limit = 30, search, projectId, dateFrom, dateTo, type } = req.query

    await dbConnect()
    await backfillDriveUploadsFromDriveFiles(companyId)

    if (!mongoose.Types.ObjectId.isValid(employeeId)) {
      return res.status(400).json({ status: false, msg: 'Invalid member id' })
    }
    const employeeObjectId = new mongoose.Types.ObjectId(employeeId)

    // Ensure employee belongs to company (avoid cross-company leaks)
    const employee = await Seat.findOne({ _id: employeeObjectId, companyId }).lean()
    if (!employee) {
      return res.status(404).json({ status: false, msg: 'Member not found' })
    }

    const match = buildPhotoMatchFilter(companyId, {
      projectId,
      employeeId,
      dateFrom,
      dateTo,
      type,
    })

    const pageNumber = Math.max(1, parseInt(page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10) || 30))
    const skip = (pageNumber - 1) * pageSize

    const pipeline = [
      { $match: match },
    ]

    if (search) {
      pipeline.push({
        $match: {
          $or: [
            { fileName: { $regex: search, $options: 'i' } },
          ],
        },
      })
    }

    pipeline.push(
      { $sort: { uploadedAt: -1 } },
      {
        $lookup: {
          from: 'drivefolders',
          localField: 'folderId',
          foreignField: '_id',
          as: 'folder',
        },
      },
      { $unwind: '$folder' },
      {
        $facet: {
          data: [
            { $skip: skip },
            { $limit: pageSize },
            {
              $project: {
                _id: 0,
                imageUrl: '$fileUrl',
                employeeId: '$employeeId',
                employeeName: {
                  $trim: {
                    input: {
                      $concat: [
                        { $ifNull: [employee.fname, ''] },
                        ' ',
                        { $ifNull: [employee.lname, ''] },
                      ],
                    },
                  },
                },
                folderId: '$folderId',
                folderName: '$folder.folderName',
                companyId: '$companyId',
                uploadedAt: '$uploadedAt',
                createdAt: '$uploadedAt',
                driveFileId: '$googleFileId',
                fileName: '$fileName',
              },
            },
          ],
          totalCount: [{ $count: 'count' }],
        },
      },
    )

    const result = await DriveUpload.aggregate(pipeline)
    const docs = result[0] || { data: [], totalCount: [] }
    const totalPhotos = docs.totalCount[0]?.count || 0

    return res.status(200).json({
      status: true,
      member: {
        employeeId: employee._id,
        employeeName: `${employee.fname || ''} ${employee.lname || ''}`.trim(),
      },
      totalPhotos,
      photos: docs.data,
      page: pageNumber,
      limit: pageSize,
    })
  } catch (err) {
    console.log('❌ getMemberPhotos', err)
    return res.status(500).json({ status: false, msg: 'Failed to fetch member photos' })
  }
}

const listFiles = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId, seatId, startDate, endDate, page = 1, limit = 20 } = req.query
    await dbConnect()

    const query = { companyId, isDeleted: false }
    if (folderId) query.folderId = folderId
    if (seatId) query.seatId = seatId
    if (startDate) query.uploadedAt = { $gte: Number(startDate) }
    if (endDate) {
      query.uploadedAt = query.uploadedAt || {}
      query.uploadedAt.$lte = Number(endDate)
    }

    const skip = (page - 1) * limit
    const files = await DriveFile.find(query)
      .populate('seatId', 'fname lname email')
      .populate('folderId', 'folderName')
      .sort({ uploadedAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()

    const total = await DriveFile.countDocuments(query)

    return res.status(200).json({ status: true, files, total, page, limit })
  } catch (err) {
    console.log('❌ listFiles', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const deleteFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    await dbConnect()
 
    const file = await DriveFile.findOne({ _id: id, companyId })
    if (!file) {
      return res.status(404).json({ msg: 'File not found' })
    }
 
    const auth = await getOAuth2Client(companyId)
    await deleteDriveFile(auth, file.googleFileId)
 
    await DriveFile.deleteMany({
      companyId,
      $or: [{ _id: file._id }, { googleFileId: file.googleFileId }],
    })
    await DriveUpload.deleteMany({ companyId, googleFileId: file.googleFileId })
 
    if (file.folderId) {
      const folder = await DriveFolder.findOne({ _id: file.folderId, companyId })
      if (folder) {
        try {
          await refreshFolderStatistics(folder.googleFolderId, companyId, auth)
        } catch (error) {
          console.log('⚠️ Failed to refresh parent folder statistics:', error.message)
        }
      }
    }
 
    await SyncLog.create({
      companyId,
      actionType: 'file_delete',
      googleFileId: file.googleFileId,
      folderId: file.folderId,
      seatId: file.seatId,
      status: 'success',
      message: `File "${file.fileName}" deleted`,
      syncedAt: now(),
    })
 
    return res.status(200).json({
      status: true,
      msg: 'File deleted successfully',
      refresh: true,
      refreshedAt: now(),
    })
  } catch (err) {
    console.log('❌ deleteFile', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const renameFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    const { newName } = req.body
    if (!newName) {
      return res.status(400).json({ msg: 'New name is required' })
    }

    await dbConnect()

    const file = await DriveFile.findOne({ _id: id, companyId })
    if (!file) {
      return res.status(404).json({ msg: 'File not found' })
    }

    const auth = await getOAuth2Client(companyId)
    await renameDriveFile(auth, file.googleFileId, newName)

    await DriveFile.findByIdAndUpdate(id, { fileName: newName })

    await SyncLog.create({
      companyId,
      actionType: 'file_rename',
      googleFileId: file.googleFileId,
      folderId: file.folderId,
      seatId: file.seatId,
      status: 'success',
      message: `File renamed to "${newName}"`,
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'File renamed successfully' })
  } catch (err) {
    console.log('❌ renameFile', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const moveFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    const { toFolderId } = req.body
    if (!toFolderId) {
      return res.status(400).json({ msg: 'Target folder ID is required' })
    }

    await dbConnect()

    const file = await DriveFile.findOne({ _id: id, companyId })
    if (!file) {
      return res.status(404).json({ msg: 'File not found' })
    }

    const toFolder = await DriveFolder.findOne({ _id: toFolderId, companyId })
    if (!toFolder) {
      return res.status(404).json({ msg: 'Target folder not found' })
    }

    const fromFolder = await DriveFolder.findOne({ _id: file.folderId, companyId })

    const auth = await getOAuth2Client(companyId)
    await moveDriveFile(auth, file.googleFileId, fromFolder.googleFolderId, toFolder.googleFolderId)

    await DriveFile.findByIdAndUpdate(id, { folderId: toFolderId })

    // Refresh source folder statistics
    if (fromFolder) {
      try {
        await refreshFolderStatistics(fromFolder.googleFolderId, companyId, auth)
      } catch (error) {
        console.log('⚠️ Failed to refresh source folder statistics:', error.message)
      }
    }

    // Refresh target folder statistics
    try {
      await refreshFolderStatistics(toFolder.googleFolderId, companyId, auth)
    } catch (error) {
      console.log('⚠️ Failed to refresh target folder statistics:', error.message)
    }

    await SyncLog.create({
      companyId,
      actionType: 'file_move',
      googleFileId: file.googleFileId,
      folderId: toFolderId,
      seatId: file.seatId,
      status: 'success',
      message: `File moved to folder "${toFolder.folderName}"`,
      syncedAt: now(),
    })

    return res.status(200).json({ status: true, msg: 'File moved successfully' })
  } catch (err) {
    console.log('❌ moveFile', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const downloadFile = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    await dbConnect()

    const file = await DriveFile.findOne({ _id: id, companyId })
    if (!file) {
      return res.status(404).json({ msg: 'File not found' })
    }

    const auth = await getOAuth2Client(companyId)
    const fileStream = await downloadDriveFile(auth, file.googleFileId)

    res.setHeader('Content-Disposition', `attachment; filename="${file.fileName}"`)
    res.setHeader('Content-Type', file.mimeType || 'application/octet-stream')
    fileStream.pipe(res)
  } catch (err) {
    console.log('❌ downloadFile', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const syncDrive = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    const folders = await DriveFolder.find({ companyId, status: 'active' }).lean()
    let syncedCount = 0
    let errorCount = 0

    const auth = await getOAuth2Client(companyId)

    for (const folder of folders) {
      try {
        const driveFiles = await listFilesInFolder(auth, folder.googleFolderId)
        
        for (const driveFile of driveFiles) {
          const existingFile = await DriveFile.findOne({ googleFileId: driveFile.id })
          
          if (!existingFile) {
            await DriveFile.create({
              companyId,
              seatId: null,
              folderId: folder._id,
              googleFileId: driveFile.id,
              fileName: driveFile.name,
              fileUrl: driveFile.webViewLink,
              mimeType: driveFile.mimeType,
              fileSize: driveFile.size,
              uploadedAt: Math.floor(new Date(driveFile.createdTime).getTime() / 1000),
              isDeleted: false,
            })
            syncedCount++
          }
        }

        await SyncLog.create({
          companyId,
          actionType: 'sync_folder',
          googleFolderId: folder.googleFolderId,
          folderId: folder._id,
          status: 'success',
          message: `Synced folder "${folder.folderName}"`,
          syncedAt: now(),
        })
      } catch (err) {
        console.log(`❌ Error syncing folder ${folder.folderName}:`, err)
        errorCount++
        
        await SyncLog.create({
          companyId,
          actionType: 'sync_folder',
          googleFolderId: folder.googleFolderId,
          folderId: folder._id,
          status: 'error',
          message: `Error syncing folder: ${err.message}`,
          syncedAt: now(),
        })
      }
    }

    return res.status(200).json({
      status: true,
      msg: 'Sync completed',
      syncedCount,
      errorCount,
    })
  } catch (err) {
    console.log('❌ syncDrive', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getSyncLogs = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { page = 1, limit = 50 } = req.query
    await dbConnect()

    const skip = (page - 1) * limit
    const logs = await SyncLog.find({ companyId })
      .sort({ syncedAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean()

    const total = await SyncLog.countDocuments({ companyId })

    return res.status(200).json({ status: true, logs, total, page, limit })
  } catch (err) {
    console.log('❌ getSyncLogs', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getEmployeeFolders = async (req, res) => {
  try {
    // adminOrMobileTokenValidator: mobile sets {user: seatId, company: companyId}
    // admin JWT sets req.user = decoded.user which has {id: companyId, ...} without .user
    const seatId = req.user.user || null
    if (!seatId) {
      return res.status(403).json({ msg: 'This endpoint is for employees only. Admin should use the admin folder endpoints.' })
    }
    await dbConnect()

    const assignments = await FolderAssignment.find({ employeeId: seatId })
      .populate('folderId')
      .lean()

    const folders = assignments.map((assignment) => ({
      ...assignment.folderId,
      assignedAt: assignment.assignedAt,
    }))

    return res.status(200).json({ status: true, folders })
  } catch (err) {
    console.log('❌ getEmployeeFolders', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const getEmployeeFolderFiles = async (req, res) => {
  try {
    // adminOrMobileTokenValidator: mobile sets {user: seatId, company: companyId}
    const seatId = req.user.user || null
    if (!seatId) {
      return res.status(403).json({ msg: 'This endpoint is for employees only. Admin should use the admin folder endpoints.' })
    }
    const { folderId } = req.params
    await dbConnect()

    const assignment = await FolderAssignment.findOne({ employeeId: seatId, folderId })
    if (!assignment) {
      return res.status(403).json({ msg: 'You do not have access to this folder' })
    }

    const files = await DriveFile.find({ folderId, isDeleted: false })
      .populate('seatId', 'fname lname')
      .sort({ uploadedAt: -1 })
      .lean()

    return res.status(200).json({ status: true, files })
  } catch (err) {
    console.log('❌ getEmployeeFolderFiles', err)
    return res.status(500).json({ msg: 'Something went wrong' })
  }
}

const updateAssignment = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params
    const { role } = req.body
    
    console.log('📝 Update Assignment Request:', { id, role, companyId })
    
    if (!role || !['reader', 'commenter', 'writer'].includes(role)) {
      return res.status(400).json({ 
        status: false, 
        msg: 'Valid role (reader, commenter, writer) is required' 
      })
    }
    
    await dbConnect()

    // Find assignment
    const assignment = await FolderAssignment.findOne({ _id: id, companyId })
    if (!assignment) {
      return res.status(404).json({ status: false, msg: 'Assignment not found' })
    }

    // Google Drive permission update
    try {
      const auth = await getOAuth2Client(companyId)
      let permissionId = assignment.permissionId
      let drivePermission = null

      if (!permissionId) {
        const drivePermissions = await listFolderPermissions(auth, assignment.googleFolderId)
        drivePermission = drivePermissions.find(p => p.emailAddress === assignment.employeeEmail && !p.deleted)
        permissionId = drivePermission?.id
      }

      if (permissionId) {
        const perm = await updateFolderPermission(auth, assignment.googleFolderId, permissionId, role)
        permissionId = perm.id || permissionId
      } else {
        if (drivePermission) {
          const perm = await updateFolderPermission(auth, assignment.googleFolderId, drivePermission.id, role)
          permissionId = perm.id || drivePermission.id
        } else {
          const perm = await shareWithUser(auth, assignment.googleFolderId, assignment.employeeEmail, role, true)
          permissionId = perm.id
        }
      }

      // Update database
      await FolderAssignment.findByIdAndUpdate(id, {
        permission: role,
        permissionId,
        updatedAt: now(),
      })
      console.log(`✅ Updated permission: ${assignment.employeeEmail} -> ${role}`)
    } catch (driveErr) {
      console.error('⚠️ Failed to update Drive permission:', driveErr.message)
      return res.status(500).json({ status: false, msg: 'Failed to update Drive permission: ' + driveErr.message })
    }

    return res.status(200).json({ status: true, msg: 'Assignment updated successfully' })
  } catch (err) {
    console.log('❌ updateAssignment', err)
    return res.status(500).json({ status: false, msg: 'Failed to update assignment' })
  }
}

const removeAssignment = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { id } = req.params

    await dbConnect()

    const assignment = await FolderAssignment.findOne({ _id: id, companyId }).lean()
    if (!assignment) {
      return res.status(404).json({ status: false, msg: 'Assignment not found' })
    }

    // Revoke Google Drive permission
    try {
      const auth = await getOAuth2Client(companyId)
      let pid = assignment.permissionId

      if (!pid) {
        // Fallback: list permissions and match by email
        const drivePermissions = await listFolderPermissions(auth, assignment.googleFolderId)
        const match = drivePermissions.find(p => p.emailAddress === assignment.employeeEmail && !p.deleted)
        pid = match?.id
      }

      if (pid) {
        await removeFolderPermission(auth, assignment.googleFolderId, pid)
        console.log(`✅ Revoked Google Drive permission for ${assignment.employeeEmail}`)
      } else {
        console.log(`⚠️ No permissionId found for ${assignment.employeeEmail}, skipping Drive revoke`)
      }
    } catch (driveErr) {
      console.error('⚠️ Failed to revoke Drive permission (continuing):', driveErr.message)
    }

    // Delete assignment record
    await FolderAssignment.findByIdAndDelete(id)

    return res.status(200).json({
      status: true,
      msg: 'Assignment removed and access revoked successfully'
    })

  } catch (err) {
    console.error('❌ removeAssignment Error:', err.message)
    console.error('❌ Stack:', err.stack)
    return res.status(500).json({ 
      status: false, 
      msg: err.message || 'Failed to remove access'
    })
  }
}

// Simple API: Sync folders from Google Drive to MongoDB
const syncFolders = async (req, res) => {
  try {
    const { id: companyId } = req.user
    await dbConnect()

    const auth = await getOAuth2Client(companyId)
    const googleFolders = await listAllFolders(auth)

    let syncedCount = 0
    let createdCount = 0
    let updatedCount = 0

    for (const folder of googleFolders) {
      const existingFolder = await DriveFolder.findOne({
        companyId,
        googleFolderId: folder.id
      })

      if (existingFolder) {
        await DriveFolder.findByIdAndUpdate(existingFolder._id, {
          folderName: folder.name,
          webViewLink: folder.webViewLink || null,
        })
        updatedCount++
      } else {
        await DriveFolder.create({
          companyId,
          googleFolderId: folder.id,
          folderName: folder.name,
          webViewLink: folder.webViewLink || null,
          createdAt: now(),
        })
        createdCount++
      }
      syncedCount++
    }

    return res.status(200).json({
      status: true,
      msg: `Synced ${syncedCount} folders (${createdCount} created, ${updatedCount} updated)`,
      synced: syncedCount,
      created: createdCount,
      updated: updatedCount,
    })
  } catch (err) {
    console.error('❌ syncFolders error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Failed to sync folders'
    })
  }
}

// Simple API: Assign folder to employees
const assignFolderSimple = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId, employeeIds } = req.body

    if (!folderId || !employeeIds || !Array.isArray(employeeIds)) {
      return res.status(400).json({
        status: false,
        msg: 'folderId and employeeIds array are required'
      })
    }

    await dbConnect()

    const folder = await DriveFolder.findOne({ _id: folderId, companyId })
    if (!folder) {
      return res.status(404).json({
        status: false,
        msg: 'Folder not found'
      })
    }

    const employees = await Seat.find({ _id: { $in: employeeIds }, companyId })
    if (employees.length === 0) {
      return res.status(404).json({
        status: false,
        msg: 'No valid employees found'
      })
    }

    let assignedCount = 0
    for (const employee of employees) {
      const existingAssignment = await FolderAssignment.findOne({
        companyId,
        employeeId: employee._id,
        folderId,
      })

      if (!existingAssignment) {
        await FolderAssignment.create({
          companyId,
          employeeId: employee._id,
          employeeEmail: employee.email,
          folderId,
          googleFolderId: folder.googleFolderId,
          folderName: folder.folderName,
          assignedAt: now(),
        })
        assignedCount++
      }
    }

    return res.status(200).json({
      status: true,
      msg: `Assigned folder to ${assignedCount} employees`,
      assigned: assignedCount,
    })
  } catch (err) {
    console.error('❌ assignFolderSimple error:', err)
    return res.status(500).json({
      status: false,
      msg: 'Failed to assign folder'
    })
  }
}

module.exports = {
  getOAuthUrl,
  handleOAuthCallback,
  getConnectionStatus,
  disconnectDrive,
  createFolder,
  listFolders,
  listGoogleDriveFolders,
  getDriveFolderContents,
  getDriveFileDetails,
  downloadDriveManagerFile,
  renameDriveManagerFile,
  moveDriveManagerFile,
  deleteDriveManagerFile,
  createDriveManagerFolder,
  renameDriveManagerFolder,
  deleteDriveManagerFolder,
  shareDriveItem,
  createPublicDriveLink,
  getDrivePermissions,
  updateDrivePermission,
  removeDrivePermission,
  deleteFolder,
  assignFolder,
  unassignFolder,
  listAssignments,
  listFolderAssignments,
  listEmployeesForAssignment,
  listFiles,
  deleteFile,
  renameFile,
  moveFile,
  downloadFile,
  syncDrive,
  getSyncLogs,
  getEmployeeFolders,
  getEmployeeFolderFiles,
  updateAssignment,
  removeAssignment,
  syncFolders,
  assignFolderSimple,
  getCompanyPhotos,
  getPhotoDetails,
  getCompanyPhotoProjects,
  getProjectPhotos,
  getCompanyPhotoMembers,
  getMemberPhotos,
}
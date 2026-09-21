const { google } = require('googleapis')
const { Readable } = require('stream')
const DriveSettings = require('../models/DriveSettings.model')
const dbConnect = require('./dbConnect')
const { now } = require('./utilities')

const SCOPES = ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/drive.file']

const getOAuth2Client = async (companyId) => {
  await dbConnect()
  const settings = await DriveSettings.findOne({ companyId, isConnected: true }).lean()
  if (!settings) {
    throw new Error('Google Drive not connected for this company')
  }

  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  )

  oauth2Client.setCredentials({
    access_token: settings.accessToken,
    refresh_token: settings.refreshToken,
  })

  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
      await DriveSettings.findOneAndUpdate(
        { companyId },
        {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          tokenExpiry: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : null,
          updatedAt: now(),
        }
      )
    } else {
      await DriveSettings.findOneAndUpdate(
        { companyId },
        {
          accessToken: tokens.access_token,
          tokenExpiry: tokens.expiry_date ? Math.floor(tokens.expiry_date / 1000) : null,
          updatedAt: now(),
        }
      )
    }
  })

  if (settings.tokenExpiry && settings.tokenExpiry < now()) {
    await oauth2Client.refreshAccessToken()
  }

  return oauth2Client
}

const uploadFile = async (auth, folderId, fileName, mimeType, buffer) => {
  const drive = google.drive({ version: 'v3', auth })
  const fileMetadata = {
    name: fileName,
    parents: folderId ? [folderId] : [],
  }

  const media = {
    mimeType,
    body: Readable.from([buffer]),
  }

  const response = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink, size, mimeType',
    supportsAllDrives: true,
  })

  return response.data
}

const createFolder = async (auth, folderName, parentFolderId = null) => {
  const drive = google.drive({ version: 'v3', auth })
  const fileMetadata = {
    name: folderName,
    mimeType: 'application/vnd.google-apps.folder',
  }

  if (parentFolderId) {
    fileMetadata.parents = [parentFolderId]
  }

  const response = await drive.files.create({
    resource: fileMetadata,
    fields: 'id, name, webViewLink',
  })

  return response.data
}

const deleteFile = async (auth, fileId) => {
  const drive = google.drive({ version: 'v3', auth })
  await drive.files.delete({
    fileId: fileId,
  })
  return { success: true }
}

const renameFile = async (auth, fileId, newName) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.files.update({
    fileId: fileId,
    resource: {
      name: newName,
    },
    fields: 'id, name',
  })
  return response.data
}

const moveFile = async (auth, fileId, fromFolderId, toFolderId) => {
  const drive = google.drive({ version: 'v3', auth })
  
  const file = await drive.files.get({
    fileId: fileId,
    fields: 'parents',
  })

  const previousParents = file.data.parents ? file.data.parents.join(',') : ''

  const response = await drive.files.update({
    fileId: fileId,
    addParents: toFolderId,
    removeParents: previousParents,
    fields: 'id, name, parents',
  })

  return response.data
}

const listFilesInFolder = async (auth, folderId) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.files.list({
    q: `'${folderId}' in parents and trashed = false`,
    fields: 'files(id, name, webViewLink, webContentLink, thumbnailLink, iconLink, size, mimeType, createdTime, modifiedTime, owners, parents, capabilities)',
    pageSize: 1000,
  })
  return response.data.files
}

const DRIVE_FILE_FIELDS = 'id, name, webViewLink, webContentLink, thumbnailLink, iconLink, size, mimeType, createdTime, modifiedTime, owners, parents, capabilities'

const listFolderContents = async (auth, folderId, options = {}) => {
  const drive = google.drive({ version: 'v3', auth })
  const {
    pageToken,
    pageSize = 50,
    search = '',
    sortBy = 'folder,name',
    order = 'asc',
    type = '',
  } = options

  const safeFolderId = folderId === 'root' ? 'root' : folderId
  let query = `'${safeFolderId}' in parents and trashed = false`
  if (search) {
    const escapedSearch = search.replace(/'/g, "\\'")
    query += ` and name contains '${escapedSearch}'`
  }
  if (type) {
    if (type === 'folder') query += ` and mimeType = 'application/vnd.google-apps.folder'`
    if (type === 'image') query += ` and mimeType contains 'image/'`
    if (type === 'pdf') query += ` and mimeType = 'application/pdf'`
    if (type === 'excel') query += ` and (mimeType = 'application/vnd.ms-excel' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' or mimeType = 'application/vnd.google-apps.spreadsheet')`
    if (type === 'document') query += ` and (mimeType = 'application/msword' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/vnd.google-apps.document')`
    if (type === 'video') query += ` and mimeType contains 'video/'`
  }

  const orderBy = sortBy
    .split(',')
    .map((field) => `${field.trim()}${order === 'desc' ? ' desc' : ''}`)
    .join(',')

  const response = await drive.files.list({
    q: query,
    fields: `nextPageToken, files(${DRIVE_FILE_FIELDS})`,
    pageSize: Math.min(Number(pageSize) || 50, 1000),
    pageToken: pageToken || undefined,
    orderBy,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })

  return response.data
}

const listAllFolders = async (auth, options = {}) => {
  const { parentFolderId = null, appCreatedOnly = false } = options
  const drive = google.drive({ version: 'v3', auth })
  
  let query = "mimeType = 'application/vnd.google-apps.folder' and trashed = false"
  
  if (parentFolderId) {
    query += ` and '${parentFolderId}' in parents`
  }
  
  if (appCreatedOnly) {
    query += " and 'me' in owners"
  }
  
  const response = await drive.files.list({
    q: query,
    fields: 'files(id, name, webViewLink, createdTime, owners, parents)',
    pageSize: 1000,
  })
  
  return response.data.files
}

const makeFolderShareable = async (auth, folderId) => {
  const drive = google.drive({ version: 'v3', auth })
  
  await drive.permissions.create({
    fileId: folderId,
    resource: {
      role: 'reader',
      type: 'anyone',
    },
    fields: 'id',
  })

  const file = await drive.files.get({
    fileId: folderId,
    fields: 'webViewLink',
  })

  return file.data.webViewLink
}

const getFile = async (auth, fileId) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.files.get({
    fileId: fileId,
    fields: DRIVE_FILE_FIELDS,
    supportsAllDrives: true,
  })
  return response.data
}

const downloadFile = async (auth, fileId) => {
  const drive = google.drive({ version: 'v3', auth })
  const file = await drive.files.get({
    fileId,
    fields: 'mimeType',
    supportsAllDrives: true,
  })

  const exportMimeTypes = {
    'application/vnd.google-apps.document': 'application/pdf',
    'application/vnd.google-apps.spreadsheet': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.google-apps.presentation': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.google-apps.drawing': 'image/png',
  }

  if (exportMimeTypes[file.data.mimeType]) {
    const response = await drive.files.export(
      { fileId, mimeType: exportMimeTypes[file.data.mimeType] },
      { responseType: 'stream' }
    )
    return response.data
  }

  const response = await drive.files.get(
    { fileId: fileId, alt: 'media', supportsAllDrives: true },
    { responseType: 'stream' }
  )
  return response.data
}

const createPermission = async (auth, fileId, permission, options = {}) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.permissions.create({
    fileId,
    requestBody: permission,
    transferOwnership: options.transferOwnership || false,
    sendNotificationEmail: options.sendNotificationEmail !== false,
    fields: 'id, type, role, emailAddress, displayName',
    supportsAllDrives: true,
  })
  return response.data
}

const listPermissions = async (auth, fileId) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.permissions.list({
    fileId,
    fields: 'permissions(id, type, role, emailAddress, displayName, photoLink, deleted), nextPageToken',
    supportsAllDrives: true,
  })
  return response.data.permissions || []
}

const updatePermission = async (auth, fileId, permissionId, role) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.permissions.update({
    fileId,
    permissionId,
    requestBody: { role },
    fields: 'id, type, role, emailAddress, displayName',
    supportsAllDrives: true,
  })
  return response.data
}

const deletePermission = async (auth, fileId, permissionId) => {
  const drive = google.drive({ version: 'v3', auth })
  await drive.permissions.delete({
    fileId,
    permissionId,
    supportsAllDrives: true,
  })
  return { success: true }
}

 /* Share a folder with a user by email
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} fileId - Google Drive file/folder ID
 * @param {string} email - User email address
 * @param {string} role - Permission role (reader, commenter, writer)
 * @param {boolean} sendNotification - Send email notification
 * @returns {Promise<Object>} Permission object
 */
const shareWithUser = async (auth, fileId, email, role = 'reader', sendNotification = true) => {
  const drive = google.drive({ version: 'v3', auth })
  
  try {
    const response = await drive.permissions.create({
      fileId: fileId,
      requestBody: {
        type: 'user',
        role: role,
        emailAddress: email,
      },
      sendNotificationEmail: sendNotification,
      fields: 'id, type, role, emailAddress, displayName',
      supportsAllDrives: true,
    })
    
    console.log(`✅ Shared ${fileId} with ${email} as ${role}`)
    return response.data
  } catch (error) {
    console.error('Share with user error:', error.message)
    throw new Error(`Failed to share with ${email}: ${error.message}`)
  }
}

/**
 * Share folder with multiple users
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} folderId - Google Drive folder ID
 * @param {Array} users - Array of {email, role} objects
 * @returns {Promise<Array>} Array of permission results
 */
const shareFolderWithMultipleUsers = async (auth, folderId, users) => {
  const results = []
  
  for (const user of users) {
    try {
      const permission = await shareWithUser(auth, folderId, user.email, user.role, true)
      results.push({
        success: true,
        email: user.email,
        role: user.role,
        permissionId: permission.id,
        permission
      })
    } catch (error) {
      results.push({
        success: false,
        email: user.email,
        role: user.role,
        error: error.message
      })
    }
  }
  
  return results
}

/**
 * Update folder permission for a user
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} fileId - Google Drive file/folder ID
 * @param {string} permissionId - Permission ID
 * @param {string} newRole - New role (reader, commenter, writer)
 * @returns {Promise<Object>} Updated permission
 */
const updateFolderPermission = async (auth, fileId, permissionId, newRole) => {
  const drive = google.drive({ version: 'v3', auth })
  
  try {
    const response = await drive.permissions.update({
      fileId: fileId,
      permissionId: permissionId,
      requestBody: {
        role: newRole,
      },
      fields: 'id, type, role, emailAddress, displayName',
      supportsAllDrives: true,
    })
    
    console.log(`✅ Updated permission ${permissionId} to ${newRole}`)
    return response.data
  } catch (error) {
    console.error('Update permission error:', error.message)
    throw new Error(`Failed to update permission: ${error.message}`)
  }
}

/**
 * Remove folder permission for a user
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} fileId - Google Drive file/folder ID
 * @param {string} permissionId - Permission ID
 * @returns {Promise<void>}
 */
const removeFolderPermission = async (auth, fileId, permissionId) => {
  const drive = google.drive({ version: 'v3', auth })
  
  try {
    await drive.permissions.delete({
      fileId: fileId,
      permissionId: permissionId,
      supportsAllDrives: true,
    })
    
    console.log(`✅ Removed permission ${permissionId}`)
    return { success: true }
  } catch (error) {
    console.error('Remove permission error:', error.message)
    throw new Error(`Failed to remove permission: ${error.message}`)
  }
}

/**
 * List all permissions for a folder
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} folderId - Google Drive folder ID
 * @returns {Promise<Array>} List of permissions
 */
const listFolderPermissions = async (auth, fileId) => {
  const drive = google.drive({ version: 'v3', auth })
  
  try {
    const response = await drive.permissions.list({
      fileId: fileId,
      fields: 'permissions(id, type, role, emailAddress, displayName, deleted)',
      supportsAllDrives: true,
    })
    
    return response.data.permissions || []
  } catch (error) {
    console.error('List permissions error:', error.message)
    return []
  }
}

/**
 * Verify if user has access to folder
 * @param {OAuth2Client} auth - OAuth2 client
 * @param {string} folderId - Google Drive folder ID
 * @param {string} email - User email
 * @returns {Promise<Object|null>} Permission if exists, null otherwise
 */
const verifyUserFolderAccess = async (auth, folderId, email) => {
  const permissions = await listFolderPermissions(auth, folderId)
  return permissions.find(p => p.emailAddress === email && !p.deleted) || null
}

module.exports = {
  SCOPES,
  getOAuth2Client,
  uploadFile,
  createFolder,
  deleteFile,
  renameFile,
  moveFile,
  listFilesInFolder,
  listFolderContents,
  listAllFolders,
  makeFolderShareable,
  getFile,
  downloadFile,
  createPermission,
  listPermissions,
  updatePermission,
  deletePermission,
  shareWithUser,
  shareFolderWithMultipleUsers,
  updateFolderPermission,
  removeFolderPermission,
  listFolderPermissions,
  verifyUserFolderAccess,
}

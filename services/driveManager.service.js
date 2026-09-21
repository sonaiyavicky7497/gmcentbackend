const { google } = require('googleapis')
const DriveFile = require('../models/DriveFile.model')
const DriveFolder = require('../models/DriveFolder.model')
const DriveUpload = require('../models/DriveUpload.model')
const SharedPermission = require('../models/SharedPermission.model')
const SyncLog = require('../models/SyncLog.model')
const { now } = require('../utils/utilities')
const {
  getOAuth2Client,
  listFolderContents,
  getFile,
  downloadFile,
  renameFile,
  moveFile,
  deleteFile,
  createFolder,
  createPermission,
  listPermissions,
  updatePermission,
  deletePermission,
} = require('../utils/googleDrive')
const FolderAssignment = require('../models/FolderAssignment.model')
const Seat = require('../models/Seat.model')

const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder'
const ALLOWED_ROLES = ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner']

const toTimestamp = (dateValue) => {
  if (!dateValue) return now()
  return Math.floor(new Date(dateValue).getTime() / 1000)
}

const normalizeDriveItem = (item) => {
  const isFolder = item.mimeType === FOLDER_MIME_TYPE
  const owner = item.owners?.[0] || null

  return {
    id: item.id,
    googleFileId: item.id,
    name: item.name,
    fileName: item.name,
    type: isFolder ? 'folder' : 'file',
    isFolder,
    mimeType: item.mimeType,
    size: item.size ? Number(item.size) : null,
    fileSize: item.size ? Number(item.size) : null,
    createdTime: item.createdTime,
    modifiedTime: item.modifiedTime,
    owner: owner
      ? {
          displayName: owner.displayName,
          emailAddress: owner.emailAddress,
          photoLink: owner.photoLink,
          me: owner.me,
        }
      : null,
    owners: item.owners || [],
    parents: item.parents || [],
    webViewLink: item.webViewLink || null,
    webContentLink: item.webContentLink || null,
    thumbnailLink: item.thumbnailLink || null,
    iconLink: item.iconLink || null,
    capabilities: item.capabilities || {},
    canEdit: !!item.capabilities?.canEdit,
    canDelete: !!(item.capabilities?.canDelete || item.capabilities?.canTrash),
    canShare: !!item.capabilities?.canShare,
  }
}

const syncItemToDatabase = async (companyId, item, localFolderId = null) => {
  const normalized = normalizeDriveItem(item)

  if (normalized.isFolder) {
    await DriveFolder.findOneAndUpdate(
      { googleFolderId: item.id },
      {
        companyId,
        folderName: item.name,
        googleFolderId: item.id,
        googleParentFolderId: item.parents?.[0] || null,
        folderLink: item.webViewLink || null,
        owners: item.owners || [],
        parents: item.parents || [],
        capabilities: item.capabilities || {},
        createdTime: item.createdTime || null,
        modifiedTime: item.modifiedTime || null,
        status: 'active',
        createdAt: toTimestamp(item.createdTime),
      },
      { upsert: true, setDefaultsOnInsert: true }
    )
    return normalized
  }

  if (localFolderId) {
    await DriveFile.findOneAndUpdate(
      { googleFileId: item.id },
      {
        companyId,
        folderId: localFolderId,
        googleFileId: item.id,
        fileName: item.name,
        fileUrl: item.webViewLink || null,
        webContentLink: item.webContentLink || null,
        thumbnailLink: item.thumbnailLink || null,
        iconLink: item.iconLink || null,
        mimeType: item.mimeType || null,
        fileSize: item.size ? Number(item.size) : null,
        owners: item.owners || [],
        parents: item.parents || [],
        capabilities: item.capabilities || {},
        createdTime: item.createdTime || null,
        modifiedTime: item.modifiedTime || null,
        uploadedAt: toTimestamp(item.createdTime),
        isDeleted: false,
      },
      { upsert: true, setDefaultsOnInsert: true }
    )
  }

  return normalized
}

const getLocalFolderId = async (companyId, googleFolderId) => {
  const folder = await DriveFolder.findOne({ companyId, googleFolderId }).lean()
  return folder?._id || null
}

const logDriveAction = async (companyId, actionType, payload = {}) => {
  await SyncLog.create({
    companyId,
    actionType,
    googleFileId: payload.googleFileId || null,
    googleFolderId: payload.googleFolderId || null,
    folderId: payload.folderId || null,
    seatId: payload.seatId || null,
    status: payload.status || 'success',
    message: payload.message || null,
    syncedAt: now(),
  })
}

const countChildFolders = async (auth, googleFolderId) => {
  const drive = google.drive({ version: 'v3', auth })
  const response = await drive.files.list({
    q: `'${googleFolderId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: 'files(id)',
    pageSize: 1000,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })
  return (response.data.files || []).length
}

const enrichFolderItems = async (companyId, auth, items) => {
  if (!items.length) return items

  const fileGoogleIds = items.filter((item) => !item.isFolder).map((item) => item.googleFileId)
  const folderGoogleIds = items.filter((item) => item.isFolder).map((item) => item.id)

  const [uploads, driveFiles, subfolderCounts] = await Promise.all([
    fileGoogleIds.length
      ? DriveUpload.find({ companyId, googleFileId: { $in: fileGoogleIds } }).lean()
      : [],
    fileGoogleIds.length
      ? DriveFile.find({ companyId, googleFileId: { $in: fileGoogleIds }, isDeleted: false }).lean()
      : [],
    folderGoogleIds.length
      ? Promise.all(
          folderGoogleIds.map(async (googleFolderId) => {
            const count = await countChildFolders(auth, googleFolderId)
            return { googleFolderId, count }
          }),
        )
      : [],
  ])

  const uploadMap = new Map(uploads.map((upload) => [upload.googleFileId, upload]))
  const fileMap = new Map(driveFiles.map((file) => [file.googleFileId, file]))
  const subfolderMap = new Map(subfolderCounts.map((entry) => [entry.googleFolderId, entry.count]))

  const employeeIds = [
    ...new Set(
      [
        ...uploads.map((upload) => upload.employeeId),
        ...driveFiles.map((file) => file.seatId),
      ]
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ]

  const seats = employeeIds.length
    ? await Seat.find({ _id: { $in: employeeIds } }, 'fname lname').lean()
    : []
  const seatMap = new Map(
    seats.map((seat) => [String(seat._id), `${seat.fname || ''} ${seat.lname || ''}`.trim()]),
  )

  return items.map((item) => {
    if (item.isFolder) {
      return {
        ...item,
        subfolderCount: subfolderMap.get(item.id) || 0,
      }
    }

    const upload = uploadMap.get(item.googleFileId)
    const dbFile = fileMap.get(item.googleFileId)
    const employeeId = upload?.employeeId || dbFile?.seatId
    const uploadedByName = employeeId ? seatMap.get(String(employeeId)) : null

    const enrichedItem = {
      ...item,
      _id: upload?._id || dbFile?._id || null,
    }

    if (!uploadedByName) return enrichedItem

    return {
      ...enrichedItem,
      uploadedByName,
      owner: {
        ...(item.owner || {}),
        displayName: uploadedByName,
      },
    }
  })
}

const reconcileFolderSnapshot = async (companyId, currentGoogleFolderId, localFolderId, visibleItems) => {
  if (!localFolderId) return

  const visibleFileIds = visibleItems.filter((item) => !item.isFolder).map((item) => item.googleFileId)
  const visibleFolderIds = visibleItems.filter((item) => item.isFolder).map((item) => item.id)

  await DriveFile.deleteMany(
    {
      companyId,
      folderId: localFolderId,
      ...(visibleFileIds.length ? { googleFileId: { $nin: visibleFileIds } } : {}),
    },
  )

  await DriveUpload.deleteMany({
    companyId,
    folderId: localFolderId,
    ...(visibleFileIds.length ? { googleFileId: { $nin: visibleFileIds } } : {}),
  })

  const missingFolders = await DriveFolder.find(
    {
      companyId,
      googleParentFolderId: currentGoogleFolderId,
      status: 'active',
      ...(visibleFolderIds.length ? { googleFolderId: { $nin: visibleFolderIds } } : {}),
    },
    '_id googleFolderId'
  ).lean()

  if (!missingFolders.length) return

  const missingFolderObjectIds = missingFolders.map((folder) => folder._id)
  const missingGoogleFolderIds = missingFolders.map((folder) => folder.googleFolderId)

  await DriveFolder.updateMany(
    { _id: { $in: missingFolderObjectIds } },
    { status: 'archived', updatedAt: now() }
  )

  await DriveFile.deleteMany(
    { companyId, folderId: { $in: missingFolderObjectIds } },
  )

  await DriveUpload.deleteMany({
    companyId,
    $or: [
      { folderId: { $in: missingFolderObjectIds } },
      { googleFolderId: { $in: missingGoogleFolderIds } },
    ],
  })
}

const getFolderContents = async (companyId, folderId, options = {}) => {
  const auth = await getOAuth2Client(companyId)
  const response = await listFolderContents(auth, folderId, options)
  const localFolderId = await getLocalFolderId(companyId, folderId)
  const items = await Promise.all(
    (response.files || []).map((item) => syncItemToDatabase(companyId, item, localFolderId))
  )
  await reconcileFolderSnapshot(companyId, folderId, localFolderId, items)
  const enrichedItems = await enrichFolderItems(companyId, auth, items)

  return {
    items: enrichedItems,
    nextPageToken: response.nextPageToken || null,
    count: enrichedItems.length,
  }
}

const getFileDetails = async (companyId, fileId) => {
  const auth = await getOAuth2Client(companyId)
  const file = await getFile(auth, fileId)
  return normalizeDriveItem(file)
}

const assertCapability = async (companyId, fileId, capability) => {
  const file = await getFileDetails(companyId, fileId)
  const capabilityMap = {
    edit: file.canEdit,
    delete: file.canDelete,
    share: file.canShare,
  }

  if (!capabilityMap[capability]) {
    const error = new Error(`You do not have permission to ${capability} this item`)
    error.statusCode = 403
    throw error
  }

  return file
}

const renameDriveItem = async (companyId, fileId, newName) => {
  await assertCapability(companyId, fileId, 'edit')
  const auth = await getOAuth2Client(companyId)
  const updated = await renameFile(auth, fileId, newName)
  const fresh = await getFile(auth, fileId)
  await syncItemToDatabase(companyId, fresh, await getLocalFolderId(companyId, fresh.parents?.[0]))
  await logDriveAction(companyId, 'drive_item_rename', {
    googleFileId: fileId,
    status: 'success',
    message: `Renamed to "${updated.name}"`,
  })
  return normalizeDriveItem(fresh)
}

const moveDriveItem = async (companyId, fileId, toFolderId) => {
  await assertCapability(companyId, fileId, 'edit')
  const auth = await getOAuth2Client(companyId)
  const updated = await moveFile(auth, fileId, null, toFolderId)
  const fresh = await getFile(auth, fileId)
  await syncItemToDatabase(companyId, fresh, await getLocalFolderId(companyId, toFolderId))
  await logDriveAction(companyId, 'drive_item_move', {
    googleFileId: fileId,
    googleFolderId: toFolderId,
    status: 'success',
    message: `Moved "${updated.name}"`,
  })
  return normalizeDriveItem(fresh)
}

const deleteDriveItem = async (companyId, fileId) => {
  await assertCapability(companyId, fileId, 'delete')
  const auth = await getOAuth2Client(companyId)
 
  // Check whether this Drive item is itself a folder we're tracking
  const trackedFolder = await DriveFolder.findOne({ companyId, googleFolderId: fileId }).lean()
 
  // Delete from Google Drive (recursively removes contents if it's a folder)
  await deleteFile(auth, fileId)
 
  if (trackedFolder) {
    // It's a folder — cascade cleanup in MongoDB via the shared,
    // double-matched, verified-clean purge function.
    const purgeResult = await driveReconcile.purgeFolderTreeById(companyId, trackedFolder._id)
 
    await logDriveAction(companyId, 'drive_item_delete', {
      googleFileId: fileId,
      googleFolderId: fileId,
      status: 'success',
      message: `Deleted folder ${fileId} (${purgeResult.foldersDeleted} folder(s), ${purgeResult.filesDeleted} file(s), ${purgeResult.uploadsDeleted} upload(s), ${purgeResult.assignmentsDeleted} assignment(s) removed)`,
    })
 
    return {
      success: true,
      deletedFolders: purgeResult.foldersDeleted,
      deletedFiles: purgeResult.filesDeleted,
      deletedAssignments: purgeResult.assignmentsDeleted,
      refresh: true,
    }
  }
 
  // It's a plain file — match by both _id-equivalent (googleFileId) keys.
  await DriveFile.deleteMany({ companyId, googleFileId: fileId })
  await DriveUpload.deleteMany({ companyId, googleFileId: fileId })
 
  await logDriveAction(companyId, 'drive_item_delete', {
    googleFileId: fileId,
    status: 'success',
    message: `Deleted Drive item ${fileId}`,
  })
  return { success: true, refresh: true }
}

const createDriveSubfolder = async (companyId, folderName, parentFolderId = null) => {
  const auth = await getOAuth2Client(companyId)
  const created = await createFolder(auth, folderName, parentFolderId)
  const fresh = await getFile(auth, created.id)
  await syncItemToDatabase(companyId, fresh)
  await logDriveAction(companyId, 'drive_folder_create', {
    googleFolderId: created.id,
    status: 'success',
    message: `Created folder "${folderName}"`,
  })
  return normalizeDriveItem(fresh)
}

const downloadDriveItem = async (companyId, fileId) => {
  const auth = await getOAuth2Client(companyId)
  const file = await getFile(auth, fileId)
  const stream = await downloadFile(auth, fileId)
  return { file: normalizeDriveItem(file), stream }
}

const shareDriveItem = async (companyId, payload) => {
  const { fileId, email, role, type = 'user', sendNotificationEmail, transferOwnership } = payload
  if (!fileId || (!email && type !== 'anyone') || !role) {
    const error = new Error('fileId, email and role are required')
    error.statusCode = 400
    throw error
  }
  if (!ALLOWED_ROLES.includes(role)) {
    const error = new Error('Unsupported permission role')
    error.statusCode = 400
    throw error
  }

  await assertCapability(companyId, fileId, 'share')
  const auth = await getOAuth2Client(companyId)
  const permission = await createPermission(
    auth,
    fileId,
    {
      type,
      role,
      ...(type === 'anyone' ? {} : { emailAddress: email }),
    },
    { sendNotificationEmail, transferOwnership: !!transferOwnership }
  )

  await SharedPermission.findOneAndUpdate(
    { companyId, googleFileId: fileId, permissionId: permission.id },
    {
      companyId,
      googleFileId: fileId,
      permissionId: permission.id,
      type: permission.type || type,
      emailAddress: permission.emailAddress || email || null,
      displayName: permission.displayName || null,
      role: permission.role || role,
      status: 'active',
      createdAt: now(),
      updatedAt: now(),
    },
    { upsert: true, setDefaultsOnInsert: true }
  )

  const file = await getFile(auth, fileId)
  await logDriveAction(companyId, 'drive_permission_create', {
    googleFileId: fileId,
    status: 'success',
    message: `Shared item with ${email || type}`,
  })

  return { permission, webViewLink: file.webViewLink }
}

const makePublicLink = async (companyId, fileId, role = 'reader') => {
  return shareDriveItem(companyId, {
    fileId,
    role,
    type: 'anyone',
    sendNotificationEmail: false,
  })
}

const getDrivePermissions = async (companyId, fileId) => {
  const auth = await getOAuth2Client(companyId)
  const permissions = await listPermissions(auth, fileId)
  await Promise.all(
    permissions.map((permission) =>
      SharedPermission.findOneAndUpdate(
        { companyId, googleFileId: fileId, permissionId: permission.id },
        {
          companyId,
          googleFileId: fileId,
          permissionId: permission.id,
          type: permission.type || 'user',
          emailAddress: permission.emailAddress || null,
          displayName: permission.displayName || null,
          role: permission.role,
          status: permission.deleted ? 'removed' : 'active',
          createdAt: now(),
          updatedAt: now(),
        },
        { upsert: true, setDefaultsOnInsert: true }
      )
    )
  )
  return permissions
}

const updateDrivePermission = async (companyId, fileId, permissionId, role) => {
  if (!fileId || !permissionId || !role) {
    const error = new Error('fileId, permissionId and role are required')
    error.statusCode = 400
    throw error
  }
  await assertCapability(companyId, fileId, 'share')
  const auth = await getOAuth2Client(companyId)
  const permission = await updatePermission(auth, fileId, permissionId, role)
  await SharedPermission.findOneAndUpdate(
    { companyId, googleFileId: fileId, permissionId },
    { role: permission.role, status: 'active', updatedAt: now() }
  )
  return permission
}

const removeDrivePermission = async (companyId, fileId, permissionId) => {
  if (!fileId || !permissionId) {
    const error = new Error('fileId and permissionId are required')
    error.statusCode = 400
    throw error
  }
  await assertCapability(companyId, fileId, 'share')
  const auth = await getOAuth2Client(companyId)
  await deletePermission(auth, fileId, permissionId)
  await SharedPermission.findOneAndUpdate(
    { companyId, googleFileId: fileId, permissionId },
    { status: 'removed', updatedAt: now() }
  )
  return { success: true }
}

/**
 * Share folder with employees
 * @param {string} companyId - Company ID
 * @param {string} folderId - Folder ID (MongoDB _id)
 * @param {Array} assignments - Array of {seatId, role} objects
 * @param {string} assignedBySeatId - Admin seat ID who is assigning
 * @returns {Promise<Object>} Assignment results
 */
const shareFolderWithEmployees = async (companyId, folderId, assignments, assignedBySeatId) => {
  // Get folder details
  const folder = await DriveFolder.findOne({ _id: folderId, companyId })
  if (!folder) {
    throw new Error('Folder not found')
  }
  
  // Get employee details
  const seatIds = assignments.map(a => a.seatId)
  const employees = await Seat.find({ 
    _id: { $in: seatIds }, 
    companyId, 
    status: 1 
  }).lean()
  
  if (employees.length === 0) {
    throw new Error('No valid employees found')
  }
  
  // Prepare users for Google sharing
  const usersToShare = employees.map(emp => {
    const assignment = assignments.find(a => a.seatId === emp._id.toString())
    return {
      email: emp.email,
      role: assignment.role,
      seatId: emp._id
    }
  })
  
  // Get OAuth client
  const auth = await getOAuth2Client(companyId)
  
  // Share folder with all employees
  const shareResults = await shareFolderWithMultipleUsers(
    auth, 
    folder.googleFolderId, 
    usersToShare.map(u => ({ email: u.email, role: u.role }))
  )
  
  // Save assignments to database
  const savedAssignments = []
  const errors = []
  
  for (const result of shareResults) {
    if (result.success) {
      const userData = usersToShare.find(u => u.email === result.email)
      
      const assignment = await FolderAssignment.create({
        companyId,
        seatId: userData.seatId,
        folderId: folder._id,
        driveFolderId: folder.googleFolderId,
        employeeEmail: result.email,
        permissionRole: result.role,
        googlePermissionId: result.permissionId,
        assignedBySeatId,
        assignedAt: now(),
        status: 'active',
      })
      
      savedAssignments.push({
        ...assignment.toObject(),
        success: true,
        employeeName: `${userData.fname} ${userData.lname}`,
      })
    } else {
      errors.push({
        email: result.email,
        error: result.error,
      })
    }
  }
  
  // Log sync action
  await SyncLog.create({
    companyId,
    actionType: 'folder_share',
    googleFolderId: folder.googleFolderId,
    folderId: folder._id,
    seatId: assignedBySeatId,
    status: errors.length === 0 ? 'success' : 'partial',
    message: `Shared folder with ${savedAssignments.length} employees${errors.length > 0 ? ` (${errors.length} failed)` : ''}`,
    syncedAt: now(),
  })
  
  return {
    success: true,
    shared: savedAssignments,
    errors: errors,
    total: assignments.length,
    successCount: savedAssignments.length,
    errorCount: errors.length,
  }
}

/**
 * Update assignment permission
 * @param {string} assignmentId - Assignment ID
 * @param {string} newRole - New role
 * @returns {Promise<Object>} Updated assignment
 */
const updateAssignmentPermission = async (assignmentId, newRole) => {
  const assignment = await FolderAssignment.findById(assignmentId)
    .populate('folderId')
  
  if (!assignment || assignment.status !== 'active') {
    throw new Error('Assignment not found')
  }
  
  // Update Google Drive permission
  const auth = await getOAuth2Client(assignment.companyId)
  await updateFolderPermission(
    auth,
    assignment.driveFolderId,
    assignment.googlePermissionId,
    newRole
  )
  
  // Update database
  assignment.permissionRole = newRole
  assignment.updatedAt = now()
  await assignment.save()
  
  // Log action
  await SyncLog.create({
    companyId: assignment.companyId,
    actionType: 'permission_update',
    googleFolderId: assignment.driveFolderId,
    folderId: assignment.folderId,
    seatId: assignment.seatId,
    status: 'success',
    message: `Updated permission to ${newRole}`,
    syncedAt: now(),
  })
  
  return assignment
}

/**
 * Remove assignment and revoke access
 * @param {string} assignmentId - Assignment ID
 * @returns {Promise<Object>} Result
 */
const removeAssignment = async (assignmentId) => {
  const assignment = await FolderAssignment.findById(assignmentId)
    .populate('folderId')
  
  if (!assignment || assignment.status !== 'active') {
    throw new Error('Assignment not found')
  }
  
  // Remove Google Drive permission
  const auth = await getOAuth2Client(assignment.companyId)
  await removeFolderPermission(
    auth,
    assignment.driveFolderId,
    assignment.googlePermissionId
  )
  
  // Update database
  assignment.status = 'revoked'
  assignment.revokedAt = now()
  await assignment.save()
  
  // Log action
  await SyncLog.create({
    companyId: assignment.companyId,
    actionType: 'permission_remove',
    googleFolderId: assignment.driveFolderId,
    folderId: assignment.folderId,
    seatId: assignment.seatId,
    status: 'success',
    message: 'Removed folder access',
    syncedAt: now(),
  })
  
  return { success: true, assignment }
}

/**
 * Get folder assignments with details
 * @param {string} companyId - Company ID
 * @returns {Promise<Array>} Assignments with details
 */
const getFolderAssignments = async (req, res) => {
  try {
    const { id: companyId } = req.user
    const { folderId } = req.params
    
    await dbConnect()
    
    const assignments = await FolderAssignment.find({ 
      companyId, 
      folderId, 
      status: 'active' 
    })
      .populate('seatId', 'fname lname email')
      .lean()
    
    return res.status(200).json({ 
      status: true, 
      assignments: assignments.map(a => ({
        seatId: a.seatId,
        permissionRole: a.permissionRole,
        employeeEmail: a.employeeEmail
      }))
    })
  } catch (err) {
    console.error('❌ getFolderAssignments Error:', err)
    return res.status(500).json({ status: false, msg: err.message })
  }
}

module.exports = {
  FOLDER_MIME_TYPE,
  normalizeDriveItem,
  getFolderContents,
  getFileDetails,
  renameDriveItem,
  moveDriveItem,
  deleteDriveItem,
  createDriveSubfolder,
  downloadDriveItem,
  shareDriveItem,
  makePublicLink,
  getDrivePermissions,
  updateDrivePermission,
  removeDrivePermission,
   shareFolderWithEmployees,
  updateAssignmentPermission,
  removeAssignment,
  getFolderAssignments,
}

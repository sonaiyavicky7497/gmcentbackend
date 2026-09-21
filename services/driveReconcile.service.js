const { google } = require('googleapis')
const DriveFolder = require('../models/DriveFolder.model')
const DriveFile = require('../models/DriveFile.model')
const DriveUpload = require('../models/DriveUpload.model')
const FolderAssignment = require('../models/FolderAssignment.model')
const SyncLog = require('../models/SyncLog.model')
const { now } = require('../utils/utilities')

// Fetch the full set of folder IDs that currently exist in Google Drive
// for this account (any folder, anywhere).
const getLiveDriveFolderIdSet = async (auth) => {
  const drive = google.drive({ version: 'v3', auth })
  const liveIds = new Set()
  let pageToken = undefined

  do {
    const response = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.folder' and trashed=false",
      fields: 'nextPageToken, files(id)',
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    })
    for (const file of response.data.files || []) {
      liveIds.add(file.id)
    }
    pageToken = response.data.nextPageToken
  } while (pageToken)

  return liveIds
}

/**
 * @param {string} companyId
 * @param {Array<{_id, googleFolderId}>} folders - folders to purge
 * @returns {Promise<{foldersDeleted, filesDeleted, uploadsDeleted, assignmentsDeleted}>}
 */
const purgeFolderRecords = async (companyId, folders) => {
  if (!folders || !folders.length) {
    return { foldersDeleted: 0, filesDeleted: 0, uploadsDeleted: 0, assignmentsDeleted: 0 }
  }

  const folderObjectIds = folders.map((f) => f._id)
  const googleFolderIds = folders.map((f) => f.googleFolderId).filter(Boolean)

  // Step 1 — find every googleFileId that DriveUpload says belongs to one
  // of these dead folders (by either key), so we can also catch DriveFile
  // rows that only line up via googleFileId, not via folderId.
  const uploadsInDeadFolders = await DriveUpload.find(
    {
      companyId,
      $or: [
        { folderId: { $in: folderObjectIds } },
        { googleFolderId: { $in: googleFolderIds } },
      ],
    },
    'googleFileId'
  ).lean()

  const orphanCandidateGoogleFileIds = uploadsInDeadFolders.map((u) => u.googleFileId).filter(Boolean)

  const fileDeleteQuery = {
    companyId,
    $or: [
      { folderId: { $in: folderObjectIds } },
      ...(googleFolderIds.length ? [{ parents: { $in: googleFolderIds } }] : []),
      ...(orphanCandidateGoogleFileIds.length
        ? [{ googleFileId: { $in: orphanCandidateGoogleFileIds } }]
        : []),
    ],
  }

  const uploadDeleteQuery = {
    companyId,
    $or: [
      { folderId: { $in: folderObjectIds } },
      { googleFolderId: { $in: googleFolderIds } },
    ],
  }

  const assignmentDeleteQuery = {
    companyId,
    $or: [
      { folderId: { $in: folderObjectIds } },
      { googleFolderId: { $in: googleFolderIds } },
    ],
  }

  // Children first (files, uploads, assignments), then the folder docs.
  const [filesResult, uploadsResult, assignmentsResult] = await Promise.all([
    DriveFile.deleteMany(fileDeleteQuery),
    DriveUpload.deleteMany(uploadDeleteQuery),
    FolderAssignment.deleteMany(assignmentDeleteQuery),
  ])

  const foldersResult = await DriveFolder.deleteMany({
    companyId,
    _id: { $in: folderObjectIds },
  })

  // Verification re-check: confirm zero DriveFile rows remain pointing at
  // any of these folders by folderId. If something still slipped through
  // (e.g. a row created in the split second between our queries), catch
  // it here and remove it too, so the caller never sees a leftover.
  const stragglers = await DriveFile.find(
    {
      companyId,
      $or: [
        { folderId: { $in: folderObjectIds } },
        ...(googleFolderIds.length ? [{ parents: { $in: googleFolderIds } }] : []),
      ],
    },
    '_id'
  ).lean()

  let stragglerDeleteCount = 0
  if (stragglers.length) {
    const stragglerResult = await DriveFile.deleteMany({
      _id: { $in: stragglers.map((s) => s._id) },
    })
    stragglerDeleteCount = stragglerResult.deletedCount
  }

  return {
    foldersDeleted: foldersResult.deletedCount,
    filesDeleted: filesResult.deletedCount + stragglerDeleteCount,
    uploadsDeleted: uploadsResult.deletedCount,
    assignmentsDeleted: assignmentsResult.deletedCount,
  }
}

const reconcileCompanyDriveFolders = async (companyId, auth) => {
  const trackedFolders = await DriveFolder.find(
    { companyId, status: 'active' },
    '_id googleFolderId googleParentFolderId folderName'
  ).lean()

  if (!trackedFolders.length) {
    return { foldersDeleted: 0, filesDeleted: 0, uploadsDeleted: 0, assignmentsDeleted: 0 }
  }

  const liveDriveFolderIds = await getLiveDriveFolderIdSet(auth)

  const directlyMissing = trackedFolders.filter((f) => !liveDriveFolderIds.has(f.googleFolderId))

  if (!directlyMissing.length) {
    return { foldersDeleted: 0, filesDeleted: 0, uploadsDeleted: 0, assignmentsDeleted: 0 }
  }

  const childrenMap = {}
  for (const f of trackedFolders) {
    const parent = f.googleParentFolderId
    if (!parent) continue
    if (!childrenMap[parent]) childrenMap[parent] = []
    childrenMap[parent].push(f)
  }

  const goneMap = new Map()
  for (const f of directlyMissing) goneMap.set(f.googleFolderId, f)

  const stack = directlyMissing.map((f) => f.googleFolderId)
  while (stack.length) {
    const currentGoogleFolderId = stack.pop()
    const children = childrenMap[currentGoogleFolderId] || []
    for (const child of children) {
      if (!goneMap.has(child.googleFolderId)) {
        goneMap.set(child.googleFolderId, child)
        stack.push(child.googleFolderId)
      }
    }
  }

  const goneFolders = Array.from(goneMap.values())
  const purgeResult = await purgeFolderRecords(companyId, goneFolders)

  try {
    await SyncLog.create({
      companyId,
      actionType: 'folder_reconcile_purge',
      status: 'success',
      message: `Detected ${goneFolders.length} folder(s) deleted directly in Google Drive (${goneFolders
        .map((f) => f.folderName)
        .join(', ')}). Purged ${purgeResult.foldersDeleted} folder doc(s), ${purgeResult.filesDeleted} file doc(s), ${purgeResult.uploadsDeleted} upload doc(s), ${purgeResult.assignmentsDeleted} assignment doc(s).`,
      syncedAt: now(),
    })
  } catch (logErr) {
    console.log('⚠️ Could not write reconcile sync log:', logErr.message)
  }

  return purgeResult
}

/**
 * @param {string} companyId
 * @param {string} rootFolderMongoId
 * @returns {Promise<{foldersDeleted, filesDeleted, uploadsDeleted, assignmentsDeleted}>}
 */
const purgeFolderTreeById = async (companyId, rootFolderMongoId) => {
  const root = await DriveFolder.findOne(
    { _id: rootFolderMongoId, companyId },
    '_id googleFolderId googleParentFolderId folderName'
  ).lean()

  if (!root) {
    return { foldersDeleted: 0, filesDeleted: 0, uploadsDeleted: 0, assignmentsDeleted: 0 }
  }

  const allFolders = await DriveFolder.find(
    { companyId },
    '_id googleFolderId googleParentFolderId folderName'
  ).lean()

  const childrenMap = {}
  for (const f of allFolders) {
    const parent = f.googleParentFolderId
    if (!parent) continue
    if (!childrenMap[parent]) childrenMap[parent] = []
    childrenMap[parent].push(f)
  }

  const toDelete = [root]
  const stack = [root.googleFolderId]
  while (stack.length) {
    const current = stack.pop()
    const children = childrenMap[current] || []
    for (const child of children) {
      toDelete.push(child)
      stack.push(child.googleFolderId)
    }
  }

  return purgeFolderRecords(companyId, toDelete)
}

module.exports = {
  getLiveDriveFolderIdSet,
  purgeFolderRecords,
  reconcileCompanyDriveFolders,
  purgeFolderTreeById,
}
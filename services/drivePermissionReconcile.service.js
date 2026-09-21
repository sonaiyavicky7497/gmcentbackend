// ============================================================================
// NEW FILE: services/drivePermissionReconcile.service.js
//
// Purpose: keep FolderAssignment in sync with the REAL sharing state of
// each folder in Google Drive. Previously, FolderAssignment only changed
// when the admin used your app's "Assign Folder" UI. If the admin instead
// opened Google Drive directly and shared/un-shared/changed someone's role
// on a folder from there, your database never found out — so the
// Assignments tab kept showing stale data and had no way to show "who is
// currently accessing this folder" accurately.
//
// This service, for a given folder, lists the folder's REAL permissions
// from the Google Drive API and reconciles FolderAssignment to match:
//   - A Drive permission for an email that has no FolderAssignment row →
//     creates one (someone was shared with directly in Drive).
//   - A FolderAssignment row whose Drive permission no longer exists →
//     deletes it (someone was un-shared directly in Drive).
//   - A FolderAssignment row whose role differs from the live Drive role →
//     updates it to match (role was changed directly in Drive).
//
// It only touches Seat-matched emails (employees you actually manage) so
// folder owners / unrelated outside collaborators aren't turned into
// fabricated "assignments".
// ============================================================================

const DriveFolder = require('../models/DriveFolder.model')
const FolderAssignment = require('../models/FolderAssignment.model')
const Seat = require('../models/Seat.model')
const SyncLog = require('../models/SyncLog.model')
const { listFolderPermissions } = require('../utils/googleDrive')
const { now } = require('../utils/utilities')

const normalizeRole = (role) => {
  const r = String(role || 'reader').toLowerCase()
  if (['writer', 'fileorganizer', 'organizer', 'owner'].includes(r)) return 'writer'
  if (r === 'commenter') return 'commenter'
  return 'reader'
}

/**
 * Reconciles FolderAssignment rows for ONE folder against its live Google
 * Drive permissions. Returns a summary of what changed.
 *
 * @param {string} companyId
 * @param {Object} folder - DriveFolder doc (needs _id, googleFolderId, folderName)
 * @param {OAuth2Client} auth
 */
const reconcileFolderPermissions = async (companyId, folder, auth) => {
  const summary = { added: 0, updated: 0, removed: 0 }

  let drivePermissions = []
  try {
    drivePermissions = await listFolderPermissions(auth, folder.googleFolderId)
  } catch (err) {
    console.log(`⚠️ reconcileFolderPermissions: could not list Drive permissions for ${folder.folderName}:`, err.message)
    return summary
  }

  const activeDrivePermissions = drivePermissions.filter((p) => !p.deleted && p.emailAddress)

  // Map every active Drive permission to a known Seat (employee), so we
  // only sync assignments for people you actually manage, not arbitrary
  // outside collaborators or the folder owner.
  const emails = activeDrivePermissions.map((p) => p.emailAddress)
  const seats = emails.length
    ? await Seat.find({ companyId, email: { $in: emails }, status: 1 }, '_id email').lean()
    : []
  const seatByEmail = new Map(seats.map((s) => [s.email, s]))

  const existingAssignments = await FolderAssignment.find({ companyId, folderId: folder._id }).lean()
  const existingByEmail = new Map(existingAssignments.map((a) => [a.employeeEmail, a]))

  const liveEmailSet = new Set()

  // ── Sync additions / role changes ──────────────────────────────────────
  for (const perm of activeDrivePermissions) {
    const seat = seatByEmail.get(perm.emailAddress)
    if (!seat) continue // not one of our employees — skip (e.g. folder owner)

    liveEmailSet.add(perm.emailAddress)
    const liveRole = normalizeRole(perm.role)
    const existing = existingByEmail.get(perm.emailAddress)

    if (!existing) {
      // Shared directly in Drive — create the missing assignment record.
      await FolderAssignment.create({
        companyId,
        employeeId: seat._id,
        employeeEmail: seat.email,
        folderId: folder._id,
        googleFolderId: folder.googleFolderId,
        folderName: folder.folderName,
        permission: liveRole,
        permissionId: perm.id,
        assignedAt: now(),
        updatedAt: now(),
      })
      summary.added++
    } else if (existing.permission !== liveRole || existing.permissionId !== perm.id) {
      // Role changed directly in Drive, or permissionId drifted — sync it.
      await FolderAssignment.findByIdAndUpdate(existing._id, {
        permission: liveRole,
        permissionId: perm.id,
        updatedAt: now(),
      })
      summary.updated++
    }
  }

  // ── Sync removals ───────────────────────────────────────────────────────
  for (const [email, existing] of existingByEmail.entries()) {
    if (!liveEmailSet.has(email)) {
      // Was un-shared directly in Drive — remove the stale assignment.
      await FolderAssignment.findByIdAndDelete(existing._id)
      summary.removed++
    }
  }

  if (summary.added || summary.updated || summary.removed) {
    try {
      await SyncLog.create({
        companyId,
        actionType: 'folder_permission_reconcile',
        googleFolderId: folder.googleFolderId,
        folderId: folder._id,
        status: 'success',
        message: `Synced assignments for "${folder.folderName}" from live Drive sharing: ${summary.added} added, ${summary.updated} updated, ${summary.removed} removed`,
        syncedAt: now(),
      })
    } catch (logErr) {
      console.log('⚠️ Could not write permission reconcile sync log:', logErr.message)
    }
  }

  return summary
}

/**
 * Reconciles FolderAssignment for EVERY active folder in the company
 * against live Drive sharing. Use this before serving the Assignments tab
 * so "who currently has access" is always accurate, including changes
 * made directly inside Google Drive.
 *
 * @param {string} companyId
 * @param {OAuth2Client} auth
 */
const reconcileAllFolderPermissions = async (companyId, auth) => {
  const folders = await DriveFolder.find(
    { companyId, status: 'active' },
    '_id googleFolderId folderName'
  ).lean()

  const totals = { added: 0, updated: 0, removed: 0 }

  for (const folder of folders) {
    const result = await reconcileFolderPermissions(companyId, folder, auth)
    totals.added += result.added
    totals.updated += result.updated
    totals.removed += result.removed
  }

  return totals
}

module.exports = {
  reconcileFolderPermissions,
  reconcileAllFolderPermissions,
}
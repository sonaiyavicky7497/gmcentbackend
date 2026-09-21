const FolderAssignment = require('../models/FolderAssignment.model')

const normalizePermission = (role) => {
  const normalized = String(role || 'reader').toLowerCase()
  if (['editor', 'edit', 'writer'].includes(normalized)) return 'writer'
  if (['commenter', 'comment'].includes(normalized)) return 'commenter'
  if (['viewer', 'view', 'reader'].includes(normalized)) return 'reader'
  return normalized
}

const canEmployeeUpload = (permission) => normalizePermission(permission) === 'writer'

const assertEmployeeFolderUploadAccess = async ({ companyId, employeeId, folderId }) => {
  const assignment = await FolderAssignment.findOne({
    companyId,
    employeeId,
    folderId,
  }).lean()

  if (!assignment) {
    const error = new Error('You do not have access to this folder')
    error.statusCode = 403
    throw error
  }

  if (!canEmployeeUpload(assignment.permission)) {
    const error = new Error('You do not have permission to upload. Editor access is required.')
    error.statusCode = 403
    throw error
  }

  return assignment
}

module.exports = {
  normalizePermission,
  canEmployeeUpload,
  assertEmployeeFolderUploadAccess,
}

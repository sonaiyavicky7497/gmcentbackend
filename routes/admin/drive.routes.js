// routes/admin/drive.routes.js - Complete working routes
const express = require('express')
const {
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
} = require('../../controller/admin/drive.controller.js')
const { uploadFileToDrive, employeeUploadFile, handleSingleFileUpload, uploadDriveManagerFile } = require('../../controller/admin/driveUpload.controller.js')
const bodyTrimmer = require('../../middleware/bodyTrimmer.js')
const { adminTokenValidator, adminOrMobileTokenValidator } = require('../../middleware/auth.middleware.js')

const driveRoute = express.Router()

// OAuth Routes
driveRoute.get('/oauth/url', adminTokenValidator, getOAuthUrl)
driveRoute.get('/oauth/callback', handleOAuthCallback)
driveRoute.get('/status', adminTokenValidator, getConnectionStatus)
driveRoute.delete('/disconnect', adminTokenValidator, disconnectDrive)

// Folder Management
driveRoute.post('/folders', bodyTrimmer, adminTokenValidator, createFolder)
driveRoute.get('/folders', adminTokenValidator, listFolders)
driveRoute.get('/google-drive/folders', adminTokenValidator, listGoogleDriveFolders)
driveRoute.delete('/folders/:id', adminTokenValidator, deleteFolder)

// Simple Folder Sync & Assignment
driveRoute.post('/sync-folders', bodyTrimmer, adminTokenValidator, syncFolders)
driveRoute.post('/assign-folder', bodyTrimmer, adminTokenValidator, assignFolderSimple)

// Drive Explorer
driveRoute.get('/folder/:folderId', adminTokenValidator, getDriveFolderContents)
driveRoute.post('/folder', bodyTrimmer, adminTokenValidator, createDriveManagerFolder)
driveRoute.post('/folder/upload', adminTokenValidator, handleSingleFileUpload, uploadDriveManagerFile)
driveRoute.patch('/folder/:folderId', bodyTrimmer, adminTokenValidator, renameDriveManagerFolder)
driveRoute.delete('/folder/:folderId', adminTokenValidator, deleteDriveManagerFolder)

// File Management
driveRoute.get('/file/:fileId', adminTokenValidator, getDriveFileDetails)
driveRoute.get('/file/:fileId/download', adminTokenValidator, downloadDriveManagerFile)
driveRoute.patch('/file/:fileId/rename', bodyTrimmer, adminTokenValidator, renameDriveManagerFile)
driveRoute.patch('/file/:fileId/move', bodyTrimmer, adminTokenValidator, moveDriveManagerFile)
driveRoute.delete('/file/:fileId', adminTokenValidator, deleteDriveManagerFile)

// Sharing
driveRoute.post('/share', bodyTrimmer, adminTokenValidator, shareDriveItem)
driveRoute.post('/share/public', bodyTrimmer, adminTokenValidator, createPublicDriveLink)
driveRoute.get('/permissions/:fileId', adminTokenValidator, getDrivePermissions)
driveRoute.patch('/permissions/:permissionId', bodyTrimmer, adminTokenValidator, updateDrivePermission)
driveRoute.delete('/permissions/:permissionId', bodyTrimmer, adminTokenValidator, removeDrivePermission)

// Assignment Routes - IMPORTANT: These must be in correct order
driveRoute.get('/folders/:id/assignments', adminTokenValidator, listFolderAssignments)
driveRoute.post('/folders/:id/assign', bodyTrimmer, adminTokenValidator, assignFolder)
driveRoute.get('/assignments', adminTokenValidator, listAssignments)
driveRoute.patch('/assignments/:id', bodyTrimmer, adminTokenValidator, updateAssignment)
driveRoute.delete('/assignments/:id', adminTokenValidator, removeAssignment)
driveRoute.get('/employees', adminTokenValidator, listEmployeesForAssignment)

// File Tracking
driveRoute.get('/files', adminTokenValidator, listFiles)
driveRoute.delete('/files/:id', adminTokenValidator, deleteFile)
driveRoute.patch('/files/:id/rename', bodyTrimmer, adminTokenValidator, renameFile)
driveRoute.patch('/files/:id/move', bodyTrimmer, adminTokenValidator, moveFile)
driveRoute.get('/files/:id/download', adminTokenValidator, downloadFile)

// Sync
driveRoute.post('/upload', adminTokenValidator, handleSingleFileUpload, uploadFileToDrive)
driveRoute.post('/sync', adminTokenValidator, syncDrive)
driveRoute.get('/sync/logs', adminTokenValidator, getSyncLogs)

// Employee Routes
driveRoute.get('/employee/folders', adminOrMobileTokenValidator, getEmployeeFolders)
driveRoute.get('/employee/folders/:folderId/files', adminOrMobileTokenValidator, getEmployeeFolderFiles)
driveRoute.post('/employee/upload', adminOrMobileTokenValidator, handleSingleFileUpload, employeeUploadFile)

// Photo Reporting Routes (DB-backed, no live Drive calls)
driveRoute.get('/photos', adminTokenValidator, getCompanyPhotos)
driveRoute.get('/photo/:id', getPhotoDetails)
driveRoute.get('/photos/projects', adminTokenValidator, getCompanyPhotoProjects)
driveRoute.get('/photos/project/:folderId', adminTokenValidator, getProjectPhotos)
driveRoute.get('/photos/members', adminTokenValidator, getCompanyPhotoMembers)
driveRoute.get('/photos/member/:employeeId', adminTokenValidator, getMemberPhotos)

module.exports = driveRoute
// models/DriveUpload.model.js
const mongoose = require('mongoose')
const { Schema, model } = mongoose

const DriveUploadSchema = new Schema(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Seat', default: null },
    companyId: { type: Schema.Types.ObjectId, required: true, ref: 'Company' },
    folderId: { type: Schema.Types.ObjectId, required: true, ref: 'DriveFolder' },
    googleFolderId: { type: String, required: true },
    googleFileId: { type: String, required: true },
    fileName: { type: String, required: true },
    fileUrl: { type: String, default: null },
    uploadedAt: { type: Number, required: true },
    
    // Image code for linking with ImageCode collection
    imageCode: { type: String, unique: true, sparse: true, index: true },
    
    // Complete image details from mobile app (42 fields)
    // Basic Info
    photoCode: { type: String, default: null }, // pc
    enterpriseCode: { type: String, default: null }, // ec
    firstName: { type: String, default: null }, // fn
    lastName: { type: String, default: null }, // ln
    email: { type: String, default: null }, // em
    
    // Device Info
    appVersion: { type: String, default: null }, // av
    deviceName: { type: String, default: null }, // dn
    os: { type: String, default: null }, // os
    
    // Location Info
    country: { type: String, default: null }, // cty
    city: { type: String, default: null }, // ct
    state: { type: String, default: null }, // st
    address: { type: String, default: null }, // addr
    latitude: { type: Number, default: null }, // from ll
    longitude: { type: Number, default: null }, // from ll
    plusCode: { type: String, default: null }, // pcd
    
    // Time Info
    captureDate: { type: String, default: null }, // cd
    captureTime: { type: String, default: null }, // tm
    timezone: { type: String, default: null }, // tz
    
    // Camera Settings
    ratio: { type: String, default: null }, // rt
    mirror: { type: String, default: null }, // mir
    cameraSide: { type: String, default: null }, // cs
    stampOnPhoto: { type: String, default: null }, // sop
    
    // Project Info
    routeTag: { type: String, default: null }, // rtag
    mapType: { type: String, default: null }, // mt
    projectName: { type: String, default: null }, // pn
    companyName: { type: String, default: null }, // cn
    
    // Additional Info
    number: { type: String, default: null }, // num
    hashtag: { type: String, default: null }, // nh
    mobile: { type: String, default: null }, // mob
    
    // Weather Info
    weatherTemp: { type: String, default: null }, // wt
    compass: { type: String, default: null }, // cmp
    mapFormat: { type: String, default: null }, // mf
    wind: { type: String, default: null }, // wnd
    humidity: { type: String, default: null }, // hum
    pressure: { type: String, default: null }, // prs
    altitude: { type: String, default: null }, // alt
    accuracy: { type: String, default: null }, // acc
    sound: { type: String, default: null }, // snd
    magneticField: { type: String, default: null }, // mf
    reportingTag: { type: String, default: null }, // rtag
    
    // Stamp Settings
    stampPosition: { type: String, default: null }, // stp
    fontSize: { type: String, default: null }, // fs
    stampPlacement: { type: String, default: null }, // sp
    mapPosition: { type: String, default: null }, // mp
    
    // Legacy fields for backward compatibility
    projectId: { type: Schema.Types.ObjectId, ref: 'DriveFolder', default: null },
    capturedAt: { type: Number, default: null },
    fileSize: { type: Number, default: 0 },
    mimeType: { type: String, default: 'image/jpeg' },
  },
  { versionKey: false, timestamps: false }
)

// Core query patterns for photo reporting:
// - by company + employee
// - by company + folder (project)
// - by company + time range
DriveUploadSchema.index({ companyId: 1, employeeId: 1, uploadedAt: -1 })
DriveUploadSchema.index({ companyId: 1, folderId: 1, uploadedAt: -1 })
DriveUploadSchema.index({ companyId: 1, uploadedAt: -1 })

// Unique index on imageCode for upsert operations
DriveUploadSchema.index({ imageCode: 1 }, { unique: true, sparse: true })

const DriveUpload = model('DriveUpload', DriveUploadSchema)
module.exports = DriveUpload

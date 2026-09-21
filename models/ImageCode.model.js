const mongoose = require('mongoose')
const { Schema, model } = mongoose

const ImageCodeSchema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    imageDetails: { type: Object, default: null },

    isUsed: { type: Boolean, default: false },
    capturedAt: { type: Number, default: null },

    // ✅ Using Number for timestamps (milliseconds)
    expiresAt: {
      type: Number,
      default: null,
      index: true,
    },
  },
  {
    versionKey: false,
    timestamps: true, // This still creates createdAt/updatedAt as Date objects

    // To make timestamps also as numbers, we need to customize
    timestamps: {
      createdAt: 'createdAt',
      updatedAt: 'updatedAt',
    },
  },
)

// Transform dates to timestamps when saving
ImageCodeSchema.pre('save', function (next) {
  // Convert expiresAt to timestamp if it's a Date
  if (this.expiresAt && this.expiresAt instanceof Date) {
    this.expiresAt = this.expiresAt.getTime()
  }
  next()
})

// Override the default timestamps to be numbers
ImageCodeSchema.pre('save', function (next) {
  const now = Date.now()

  // Set createdAt only if it's a new document
  if (this.isNew) {
    this.createdAt = now
  }

  // Always update updatedAt
  this.updatedAt = now

  next()
})

// Remove the automatic timestamps and handle manually
const schema = new Schema(
  {
    code: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },

    imageDetails: { type: Object, default: null },

    isUsed: { type: Boolean, default: false },
    capturedAt: { type: Number, default: null },

    expiresAt: {
      type: Number,
      default: null,
      index: true,
    },

    companyId: {
      type: Schema.Types.ObjectId,
      ref: 'Company',
      default: null,
      index: true,
    },

    seatId: {
      type: Schema.Types.ObjectId,
      ref: 'Seat',
      default: null,
      index: true,
      // NOTE: The unique index 'unique_pending_per_user' on { seatId: 1, isUsed: 1 } needs to be dropped from the database
      // Run: db.imagecodes.dropIndex('unique_pending_per_user')
    },

    licenseEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'Seat',
      default: null,
      index: true,
    },

    license: { type: String, default: null },
    invitationId: { type: Schema.Types.ObjectId, ref: 'Seat', default: null },

    // Manual timestamp fields
    createdAt: {
      type: Number,
      default: Date.now,
    },

    updatedAt: {
      type: Number,
      default: Date.now,
    },
  },
  {
    versionKey: false,
    // Removed timestamps: true
  },
)

// Update updatedAt on save
schema.pre('save', function (next) {
  this.updatedAt = Date.now()
  next()
})

// Update updatedAt on update operations
schema.pre('findOneAndUpdate', function () {
  this.set({ updatedAt: Date.now() })
})

schema.pre('updateOne', function () {
  this.set({ updatedAt: Date.now() })
})

// Check if model exists before creating it
module.exports = mongoose.models.ImageCode || model('ImageCode', schema)
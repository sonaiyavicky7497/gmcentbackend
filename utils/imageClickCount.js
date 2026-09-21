const mongoose = require('mongoose')
const ImageCode = require('../models/ImageCode.model')
const Seat = require('../models/Seat.model')

const normalizeEmail = (email) => {
  if (!email || typeof email !== 'string') return ''
  return email.trim().toLowerCase()
}

/**
 * Single source of truth for valid Image Code records.
 * Valid = imageDetails exists, is not null, and is a non-empty object.
 * Excludes null/missing imageDetails records from totals.
 */
const getValidImageCodeFilter = (companyId, extraFilters = {}) => {
  const filter = {
    ...extraFilters,
    imageDetails: { $exists: true, $ne: null },
    $expr: { $gt: [{ $size: { $objectToArray: { $ifNull: ['$imageDetails', {}] } } }, 0] },
  }

  if (companyId) {
    filter.companyId = new mongoose.Types.ObjectId(companyId)
  }

  return filter
}

const countValidImageCodes = async (companyId, extraFilters = {}) => {
  return ImageCode.countDocuments(getValidImageCodeFilter(companyId, extraFilters))
}

const getCodeTimestampMs = (code) => {
  const capturedAt = Number(code.capturedAt)
  if (capturedAt) {
    return capturedAt < 1e12 ? capturedAt * 1000 : capturedAt
  }

  const createdAt = Number(code.createdAt)
  if (createdAt) {
    return createdAt < 1e12 ? createdAt * 1000 : createdAt
  }

  return 0
}

const getSeatTimestampMs = (seat) => {
  const createdAt = Number(seat?.createdAt)
  if (!createdAt) return 0
  return createdAt < 1e12 ? createdAt * 1000 : createdAt
}

const assignLegacyCodeToSeat = (code, emailSeats) => {
  if (!emailSeats.length) return null

  const sortedSeats = [...emailSeats].sort((a, b) => getSeatTimestampMs(a) - getSeatTimestampMs(b))
  const codeTimestamp = getCodeTimestampMs(code)

  for (let i = 0; i < sortedSeats.length; i++) {
    const seat = sortedSeats[i]
    const seatStart = getSeatTimestampMs(seat)
    const nextSeat = sortedSeats[i + 1]
    const nextStart = nextSeat ? getSeatTimestampMs(nextSeat) : Number.POSITIVE_INFINITY

    if (codeTimestamp >= seatStart && codeTimestamp < nextStart) {
      return seat._id.toString()
    }
  }

  return sortedSeats[sortedSeats.length - 1]._id.toString()
}

/**
 * Build per-license-entry image click counts from valid ImageCode records.
 * Uses seatId / licenseEntryId when present; otherwise assigns by normalized email + time period.
 */
const buildImageClickCountsForSeats = async (seats, companyId) => {
  const entryCounts = new Map()

  if (!companyId) {
    return { entryCounts, lifetimeByEmail: new Map(), unmatchedCount: 0 }
  }

  const companyObjectId = new mongoose.Types.ObjectId(companyId)
  const pageSeatIds = (seats || []).map((seat) => seat._id).filter(Boolean)
  const validFilter = getValidImageCodeFilter(companyId)

  const allCompanySeats = await Seat.find({ companyId: companyObjectId }).lean()
  const companySeatIdSet = new Set(allCompanySeats.map((seat) => seat._id.toString()))

  const seatsByEmail = new Map()
  allCompanySeats.forEach((seat) => {
    const emailKey = normalizeEmail(seat.email)
    if (!emailKey) return
    if (!seatsByEmail.has(emailKey)) seatsByEmail.set(emailKey, [])
    seatsByEmail.get(emailKey).push(seat)
  })

  const validCodes = await ImageCode.find(validFilter)
    .select('seatId licenseEntryId imageDetails.em capturedAt createdAt')
    .lean()

  let unmatchedCount = 0

  validCodes.forEach((code) => {
    const entryId = code.licenseEntryId?.toString() || code.seatId?.toString()

    if (entryId && companySeatIdSet.has(entryId)) {
      entryCounts.set(entryId, (entryCounts.get(entryId) || 0) + 1)
      return
    }

    const emailKey = normalizeEmail(code.imageDetails?.em)
    const emailSeats = seatsByEmail.get(emailKey) || []
    const assignedSeatId = assignLegacyCodeToSeat(code, emailSeats)

    if (!assignedSeatId) {
      unmatchedCount += 1
      return
    }

    entryCounts.set(assignedSeatId, (entryCounts.get(assignedSeatId) || 0) + 1)
  })

  const lifetimeByEmail = new Map()
  allCompanySeats.forEach((seat) => {
    const emailKey = normalizeEmail(seat.email)
    const seatId = seat._id.toString()
    const count = entryCounts.get(seatId) || 0
    lifetimeByEmail.set(emailKey, (lifetimeByEmail.get(emailKey) || 0) + count)
  })

  pageSeatIds.forEach((seatId) => {
    const seatIdStr = seatId.toString()
    if (!entryCounts.has(seatIdStr)) {
      entryCounts.set(seatIdStr, 0)
    }
  })

  return { entryCounts, lifetimeByEmail, unmatchedCount }
}

const getSeatImageClickCount = (seat, entryCounts) => {
  if (!seat?._id) return 0
  return entryCounts.get(seat._id.toString()) || 0
}

const getSeatLifetimeClickCount = (seat, lifetimeByEmail) => {
  return lifetimeByEmail.get(normalizeEmail(seat.email)) || 0
}

const applyPhotoCodeFilters = (companyId, options = {}) => {
  const {
    search = '',
    status = 'all',
    fromDate = '',
    toDate = '',
    licenseEntryId = '',
    userEmail = '',
  } = options

  const query = getValidImageCodeFilter(companyId)

  if (fromDate || toDate) {
    const dateQuery = {}
    if (fromDate) {
      const fromTimestamp = Date.parse(`${String(fromDate).trim()}T00:00:00`)
      if (!Number.isNaN(fromTimestamp)) {
        dateQuery.$gte = fromTimestamp
      }
    }
    if (toDate) {
      const toTimestamp = Date.parse(`${String(toDate).trim()}T23:59:59.999`)
      if (!Number.isNaN(toTimestamp)) {
        dateQuery.$lte = toTimestamp
      }
    }
    if (Object.keys(dateQuery).length) {
      query.createdAt = dateQuery
    }
  }

  if (status === 'active' || status === 'used') {
    query.isUsed = true
  } else if (status === 'unused') {
    query.isUsed = false
  }

  const trimmedSearch = String(search || '').trim()
  if (trimmedSearch) {
    const searchRegex = { $regex: trimmedSearch, $options: 'i' }
    query.$or = [
      { code: searchRegex },
      { 'imageDetails.fn': searchRegex },
      { 'imageDetails.ln': searchRegex },
      { 'imageDetails.em': searchRegex },
      { 'imageDetails.dn': searchRegex },
      { 'imageDetails.location': searchRegex },
      { 'imageDetails.browser': searchRegex },
      { 'imageDetails.os': searchRegex },
      { 'imageDetails.device': searchRegex },
      { 'imageDetails.deviceName': searchRegex },
      { 'imageDetails.userName': searchRegex },
    ]
  }

  const normalizedUserEmail = normalizeEmail(userEmail)
  if (normalizedUserEmail) {
    query['imageDetails.em'] = {
      $regex: `^${normalizedUserEmail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
      $options: 'i',
    }
  }

  const entryId = String(licenseEntryId || '').trim()
  if (entryId && mongoose.Types.ObjectId.isValid(entryId)) {
    const entryObjectId = new mongoose.Types.ObjectId(entryId)
    query.$and = query.$and || []
    query.$and.push({
      $or: [{ licenseEntryId: entryObjectId }, { seatId: entryObjectId }],
    })
  }

  return query
}

module.exports = {
  normalizeEmail,
  getValidImageCodeFilter,
  countValidImageCodes,
  buildImageClickCountsForSeats,
  getSeatImageClickCount,
  getSeatLifetimeClickCount,
  applyPhotoCodeFilters,
}

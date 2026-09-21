const mongoose = require('mongoose')
const { Schema, model, Types } = mongoose

const SeatSchema = new Schema(
  {
    companyId: { type: Types.ObjectId, default: null, ref: 'Company' },
    fname: { type: String, required: true },
    lname: { type: String, required: true },
    email: { type: String, required: true },
    license: { type: String, required: true, unique: true },
    role: { type: String, default: null },
    phoneCode: { type: String, default: null },
    phone: { type: String, default: null },
    address: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    country: { type: String, default: null },
    status: { type: String, required: true }, // 0: Pending, 1: Active, 2: User Left, 3: Deactivated
    device: { type: String, default: null },
    imei: { type: String, default: null },
    lastActive: { type: String, default: null },
    createdAt: { type: Number, required: true },
    validationToken: { type: String, default: null },
    validationTokenExpiry: { type: Number, default: null },
    enterpriseId: { type: String, default: null }, // Store enterprise/company ID for reference
  },
  { versionKey: false, timestamps: false },
)

const Seat = model('Seat', SeatSchema)
module.exports = Seat

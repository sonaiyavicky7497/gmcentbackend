#!/usr/bin/env node
const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '../.env') })
const dbConnect = require('../utils/dbConnect')
const Company = require('../models/Company.model')

async function migrateSeats() {
  console.log('='.repeat(60))
  console.log('🚀 Starting Seat Management Migration to totalSeat, usedSeat, remainingSeat')
  console.log('='.repeat(60))

  try {
    console.log('🔗 Connecting to database...')
    await dbConnect()
    console.log('✅ Connected to database.')

    const companies = await Company.find({}).lean()
    console.log(`📊 Found ${companies.length} company records to evaluate.`)

    let updatedCount = 0
    let alreadyMigratedCount = 0

    for (const company of companies) {
      const companyIdentifier = company.companyName || company.email || company.companyId || company._id

      const usedSeat = company.usedSeat !== undefined ? company.usedSeat : (company.seatPurchased || 0)
      const remainingSeat = company.remainingSeat !== undefined ? company.remainingSeat : (company.seatCapacity || 0)
      const totalSeat = company.totalSeat !== undefined ? company.totalSeat : (usedSeat + remainingSeat)

      const needsUpdate =
        company.totalSeat === undefined ||
        company.usedSeat === undefined ||
        company.remainingSeat === undefined ||
        company.totalSeat !== totalSeat ||
        company.usedSeat !== usedSeat ||
        company.remainingSeat !== remainingSeat

      if (needsUpdate) {
        await Company.updateOne(
          { _id: company._id },
          {
            $set: {
              totalSeat,
              usedSeat,
              remainingSeat,
              seatPurchased: usedSeat,
              seatCapacity: remainingSeat,
            },
          },
        )
        console.log(
          `✅ Migrated [${companyIdentifier}]: totalSeat=${totalSeat}, usedSeat=${usedSeat}, remainingSeat=${remainingSeat} (was: capacity=${company.seatCapacity}, purchased=${company.seatPurchased})`,
        )
        updatedCount++
      } else {
        alreadyMigratedCount++
      }
    }

    console.log('='.repeat(60))
    console.log(`🎉 Migration Completed Successfully!`)
    console.log(`Updated companies: ${updatedCount}`)
    console.log(`Already up-to-date: ${alreadyMigratedCount}`)
    console.log(`Total companies: ${companies.length}`)
    console.log('='.repeat(60))
    process.exit(0)
  } catch (error) {
    console.error('❌ Migration failed with error:', error)
    process.exit(1)
  }
}

migrateSeats()

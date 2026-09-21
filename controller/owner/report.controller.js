const Transaction = require('../../models/Transaction.model')
const Company = require('../../models/Company.model')
const BillingInfo = require('../../models/BillingInfo.model')
const { Parser } = require('json2csv')
const XLSX = require('xlsx')
const { jsPDF } = require('jspdf')
const autoTable = require('jspdf-autotable').default
const moment = require('moment')

const fetchReportData = async (startDate, endDate, order = 'asc') => {
  const start = Math.floor(new Date(startDate).setHours(0, 0, 0, 0) / 1000)
  const end = Math.floor(new Date(endDate).setHours(23, 59, 59, 999) / 1000)

  // Set sort order: 1 for ascending (oldest first), -1 for descending (newest first)
  const sortOrder = order === 'asc' ? 1 : -1

  const transactions = await Transaction.find({
    createdAt: { $gte: start, $lte: end },
    status: 'completed',
    type: { $in: [1, 2, 5] }, // Purchase, Upgrade, Renewal
  })
    .populate('userId', 'email fName lName companyName address city state country phoneCode phone gstin totalSeat usedSeat remainingSeat seatPurchased seatCapacity')
    .sort({ createdAt: sortOrder })
    .lean()

  // Deduplicate transactions by paymentId to handle potential database duplicates
  const uniqueTransactions = [];
  const seenPaymentIds = new Set();
  
  for (const t of transactions) {
    if (t.paymentId) {
      if (seenPaymentIds.has(t.paymentId)) {
        continue;
      }
      seenPaymentIds.add(t.paymentId);
    }
    uniqueTransactions.push(t);
  }

  // Get unique company IDs to fetch billing info
  const companyIds = [...new Set(uniqueTransactions.map((t) => t.userId?._id || t.userId).filter(Boolean))]
  const billingInfos = await BillingInfo.find({ owner: { $in: companyIds }, isDeleted: false }).lean()

  // Map billing info by owner ID for quick lookup
  const billingMap = billingInfos.reduce((acc, curr) => {
    acc[curr.owner.toString()] = curr
    return acc
  }, {})

  return uniqueTransactions.map((t) => {
    const company = t.userId && typeof t.userId === 'object' ? t.userId : {}
    const companyId = company._id || t.userId
    const billing = companyId && billingMap[companyId.toString()] ? billingMap[companyId.toString()] : {}

    const getValue = (val) => {
      if (val === null || val === undefined) return 'N/A'
      const str = val.toString().trim()
      return str === '' ? 'N/A' : str
    }

    const companyAddressParts = [getValue(company.address), getValue(company.city), getValue(company.state), getValue(company.country)]

    const billingAddressParts = [
      billing.line1 ? `${billing.line1}${billing.line2 ? ', ' + billing.line2 : ''}` : company.address,
      billing.city || company.city,
      billing.state || company.state,
      billing.country || company.country,
    ].map(getValue)

    return {
      date: t.createdAt,
      companyName: getValue(company.companyName),
      name: getValue(`${company.fName || ''} ${company.lName || ''}`),
      email: getValue(company.email),
      plan: getValue(t.plan || company.plan),
      amount: t.amount || 0,
      seatUsage: `${company.usedSeat !== undefined ? company.usedSeat : (company.seatPurchased || 0)}/${company.totalSeat !== undefined ? company.totalSeat : ((company.seatPurchased || 0) + (company.seatCapacity || 0))}`,

      // Company Address
      companyAddress: companyAddressParts[0],
      companyCity: companyAddressParts[1],
      companyState: companyAddressParts[2],
      companyCountry: companyAddressParts[3],

      // Billing Address
      billingAddress: billingAddressParts[0],
      billingCity: billingAddressParts[1],
      billingState: billingAddressParts[2],
      billingCountry: billingAddressParts[3],
      billingZipcode: getValue(billing.zipcode),

      phoneCode: getValue(company.phoneCode).replace('N/A', ''),
      mobileNumber: getValue(company.phone),
      paymentId: getValue(t.paymentId),
    }
  })
}

exports.getReports = async (req, res) => {
  try {
    const { startDate, endDate } = req.query

    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Start date and end date are required' })
    }

    // Frontend gets descending order (newest first)
    const reports = await fetchReportData(startDate, endDate, 'desc')

    res.status(200).json({
      success: true,
      data: reports,
    })
  } catch (error) {
    console.error('Error fetching reports:', error)
    res.status(500).json({ message: 'Internal server error' })
  }
}

exports.exportCSV = async (req, res) => {
  try {
    const { startDate, endDate } = req.query
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Dates are required' })
    }

    // CSV export gets ascending order (oldest first)
    const reports = await fetchReportData(startDate, endDate, 'asc')

    const fields = [
      { label: 'Date', value: (row) => moment(row.date * 1000).format('DD MMM YYYY HH:mm') },
      { label: 'Company Name', value: 'companyName' },
      { label: 'Owner Name', value: 'name' },
      { label: 'Email', value: 'email' },
      { label: 'Mobile', value: (row) => `${row.phoneCode} ${row.mobileNumber}` },
      { label: 'Plan', value: 'plan' },
      { label: 'Seat Usage', value: 'seatUsage' },
      { label: 'Amount (INR)', value: 'amount' },
      { label: 'Country', value: 'companyCountry' },
      { label: 'Company Address', value: (row) => `${row.companyAddress}, ${row.companyCity}, ${row.companyState}, ${row.companyCountry}` },
      {
        label: 'Billing Address',
        value: (row) => `${row.billingAddress}, ${row.billingCity}, ${row.billingState}, ${row.billingCountry} - ${row.billingZipcode}`,
      },
      { label: 'Payment ID', value: 'paymentId' },
    ]

    const json2csvParser = new Parser({ fields })
    const csv = json2csvParser.parse(reports)

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="Report_${moment(startDate).format('YYYYMMDD')}_to_${moment(endDate).format('YYYYMMDD')}.csv"`,
    )
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')

    return res.status(200).send(csv)
  } catch (error) {
    console.error('CSV Export Error:', error)
    return res.status(500).json({ message: 'Failed to export CSV' })
  }
}

exports.exportExcel = async (req, res) => {
  try {
    const { startDate, endDate } = req.query
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Dates are required' })
    }

    // Excel export gets ascending order (oldest first)
    const reports = await fetchReportData(startDate, endDate, 'asc')

    const excelData = reports.map((r) => ({
      Date: moment(r.date * 1000).format('DD MMM YYYY HH:mm'),
      'Company Name': r.companyName,
      'Owner Name': r.name,
      Email: r.email,
      Mobile: `${r.phoneCode} ${r.mobileNumber}`,
      Plan: r.plan,
      'Seat Usage': r.seatUsage,
      'Amount (INR)': r.amount,
      Country: r.companyCountry,
      'Company Address': `${r.companyAddress}, ${r.companyCity}, ${r.companyState}, ${r.companyCountry}`,
      'Billing Address': `${r.billingAddress}, ${r.billingCity}, ${r.billingState}, ${r.billingCountry} - ${r.billingZipcode}`,
      'Payment ID': r.paymentId,
    }))

    const ws = XLSX.utils.json_to_sheet(excelData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Reports')

    const buffer = XLSX.write(wb, {
      type: 'buffer',
      bookType: 'xlsx',
    })

    res.status(200)
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename=Report_${moment(startDate).format('YYYYMMDD')}_to_${moment(endDate).format('YYYYMMDD')}.xlsx`,
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
      Connection: 'close',
    })

    return res.send(buffer)
  } catch (error) {
    console.error('Excel Export Error:', error)
    res.status(500).json({ message: 'Failed to export Excel' })
  }
}

exports.exportPDF = async (req, res) => {
  try {
    const { startDate, endDate } = req.query
    if (!startDate || !endDate) {
      return res.status(400).json({ message: 'Dates are required' })
    }

    // PDF export gets ascending order (oldest first)
    const reports = await fetchReportData(startDate, endDate, 'asc')

    const doc = new jsPDF({ orientation: 'landscape' })

    // Add Header
    doc.setFontSize(18)
    doc.text('Company Plan Purchase Report', 14, 20)
    doc.setFontSize(11)
    doc.text(`Period: ${moment(startDate).format('DD MMM YYYY')} - ${moment(endDate).format('DD MMM YYYY')}`, 14, 30)

    const totalRevenue = reports.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0)
    doc.text(`Total Transactions: ${reports.length} | Total Revenue: INR ${totalRevenue.toLocaleString('en-IN')}`, 14, 38)

    const tableRows = reports.map((r) => [
      moment(r.date * 1000).format('DD MMM YY'),
      r.companyName,
      r.name,
      r.email,
      `${r.phoneCode} ${r.mobileNumber}`,
      r.plan,
      r.seatUsage,
      `INR ${r.amount.toLocaleString('en-IN')}`,
      r.companyCountry,
      `${r.companyAddress}, ${r.companyCity}, ${r.companyState}`,
      `${r.billingAddress}, ${r.billingCity}, ${r.billingState} - ${r.billingZipcode}`,
      r.paymentId,
    ])

    autoTable(doc, {
      head: [
        ['Date', 'Company', 'Owner', 'Email', 'Mobile', 'Plan', 'Seats', 'Amount', 'Country', 'Company Address', 'Billing Address', 'Payment ID'],
      ],
      body: tableRows,
      startY: 45,
      theme: 'striped',
      headStyles: { fillColor: [93, 95, 239] },
      styles: { fontSize: 6.5, cellPadding: 1.5, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 15 }, // Date
        1: { cellWidth: 25 }, // Company
        2: { cellWidth: 20 }, // Owner
        3: { cellWidth: 35 }, // Email
        4: { cellWidth: 20 }, // Mobile
        5: { cellWidth: 15 }, // Plan
        6: { cellWidth: 12 }, // Seats
        7: { cellWidth: 18 }, // Amount
        8: { cellWidth: 15 }, // Country
        9: { cellWidth: 35 }, // Company Addr
        10: { cellWidth: 35 }, // Billing Addr
        11: { cellWidth: 35 }, // Payment ID
      },
    })

    const pdfBuffer = Buffer.from(doc.output('arraybuffer'))

    res.status(200)
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename=Report_${moment(startDate).format('YYYYMMDD')}_to_${moment(endDate).format('YYYYMMDD')}.pdf`,
      'Content-Length': pdfBuffer.length,
      'Cache-Control': 'no-store',
      Pragma: 'no-cache',
      Expires: '0',
      Connection: 'close',
    })

    return res.send(pdfBuffer)
  } catch (error) {
    console.error('PDF Export Error:', error)
    res.status(500).json({ message: 'Failed to export PDF' })
  }
}

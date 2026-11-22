const PDFDocument = require('pdfkit');
const config = require('../config');

const NAVY = '#0B1F3A';
const ORANGE = '#F97316';

/** Streams a PDF receipt for a paid payment. `payment` must be populated with owner, bus, subscription. */
function streamReceipt(res, payment) {
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="receipt-${payment.receiptNumber || payment._id}.pdf"`);
  doc.pipe(res);

  doc.rect(0, 0, doc.page.width, 110).fill(NAVY);
  doc.fillColor('#FFFFFF').fontSize(24).font('Helvetica-Bold').text(config.company.name, 50, 38);
  doc.fillColor(ORANGE).fontSize(11).font('Helvetica').text('Daily Bus Information & Listing Platform', 50, 68);
  doc.fillColor('#FFFFFF').fontSize(18).font('Helvetica-Bold').text('PAYMENT RECEIPT', 0, 45, { align: 'right', width: doc.page.width - 50 });

  doc.fillColor('#111827').fontSize(10).font('Helvetica');
  let y = 140;
  const row = (label, value) => {
    doc.font('Helvetica-Bold').text(label, 50, y, { width: 160 });
    doc.font('Helvetica').text(value ?? '—', 210, y, { width: 330 });
    y += 20;
  };

  row('Receipt No.', payment.receiptNumber);
  row('Date', payment.paidAt ? new Date(payment.paidAt).toLocaleString('en-IN', { timeZone: config.timezone }) : '—');
  row('Payment ID', payment.razorpayPaymentId || payment._id.toString());
  row('Order ID', payment.razorpayOrderId);
  row('Gateway', payment.gateway === 'mock' ? 'Test payment (mock mode)' : 'Razorpay');
  y += 10;
  doc.moveTo(50, y).lineTo(545, y).strokeColor('#E5E7EB').stroke();
  y += 15;
  row('Billed To', payment.owner?.companyName);
  row('Contact', `${payment.owner?.ownerName || ''} · ${payment.owner?.mobile || ''}`);
  row('Email', payment.owner?.email);
  y += 10;
  doc.moveTo(50, y).lineTo(545, y).stroke();
  y += 20;

  doc.rect(50, y, 495, 26).fill('#F3F4F6');
  doc.fillColor('#111827').font('Helvetica-Bold').text('Description', 60, y + 8).text('Amount (INR)', 400, y + 8, { width: 135, align: 'right' });
  y += 36;
  const sub = payment.subscription;
  const desc = `${sub?.planSnapshot?.name || 'Listing subscription'} (${sub?.planSnapshot?.durationDays || ''} days) — ${payment.bus?.name || ''} [${payment.bus?.registrationNumber || ''}]`;
  doc.font('Helvetica').text(desc, 60, y, { width: 330 });
  doc.text(Number(payment.amount).toFixed(2), 400, y, { width: 135, align: 'right' });
  y += 40;
  doc.moveTo(50, y).lineTo(545, y).stroke();
  y += 12;
  doc.font('Helvetica-Bold').fontSize(12).text('Total Paid', 60, y).fillColor(ORANGE).text(`Rs. ${Number(payment.amount).toFixed(2)}`, 400, y, { width: 135, align: 'right' });
  y += 30;
  if (sub?.startDate && sub?.endDate) {
    doc.fillColor('#374151').font('Helvetica').fontSize(10).text(`Listing period: ${new Date(sub.startDate).toDateString()} – ${new Date(sub.endDate).toDateString()}`, 60, y);
    y += 16;
  } else {
    doc.fillColor('#374151').font('Helvetica').fontSize(10).text('Listing period starts when the listing is approved by the admin.', 60, y);
    y += 16;
  }
  if (payment.status === 'refunded') {
    doc.fillColor('#DC2626').font('Helvetica-Bold').text(`REFUNDED: Rs. ${payment.refundedAmount} (${payment.refundReason || ''})`, 60, y + 6);
  }

  doc.fillColor('#6B7280').fontSize(9).font('Helvetica').text(
    `${config.company.name} · ${config.company.address}${config.company.gstin ? ` · GSTIN ${config.company.gstin}` : ''} · ${config.company.supportEmail}\nThis is a computer-generated receipt and does not require a signature.`,
    50,
    760,
    { align: 'center', width: 495 }
  );
  doc.end();
}

module.exports = { streamReceipt };

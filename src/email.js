const nodemailer = require('nodemailer');
const config = require('./config');

const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465,
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});

async function notifyOwner(subject, body) {
  await transporter.sendMail({
    from: config.email.from,
    to: config.business.ownerEmail,
    subject,
    text: body,
  });
}

module.exports = { notifyOwner };

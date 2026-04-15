const sgMail = require("@sendgrid/mail");
const twilio = require("twilio");

function canSendReal() {
  return String(process.env.ENABLE_REAL_NOTIFICATIONS || "false") === "true";
}

async function sendSMS(to, message) {
  if (!canSendReal()) {
    console.log(`[DEMO SMS] ${to}: ${message}`);
    return;
  }

  const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  await client.messages.create({
    from: process.env.TWILIO_FROM_NUMBER,
    to,
    body: message
  });
}

async function sendEmail(to, subject, message) {
  if (!canSendReal()) {
    console.log(`[DEMO EMAIL] ${to}: ${subject} :: ${message}`);
    return;
  }

  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  await sgMail.send({
    to,
    from: process.env.EMAIL_FROM,
    subject: subject || "Shop Update",
    text: message
  });
}

async function sendQueuedNotifications(prisma) {
  const queued = await prisma.notification.findMany({
    where: { status: "QUEUED" },
    take: 20,
    orderBy: { createdAt: "asc" }
  });

  for (const item of queued) {
    try {
      if (item.type === "SMS") {
        await sendSMS(item.recipient, item.message);
      } else {
        await sendEmail(item.recipient, item.subject, item.message);
      }

      await prisma.notification.update({
        where: { id: item.id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          errorMessage: null
        }
      });
    } catch (err) {
      await prisma.notification.update({
        where: { id: item.id },
        data: {
          status: "FAILED",
          errorMessage: String(err.message || err)
        }
      });
    }
  }
}

module.exports = { sendQueuedNotifications, canSendReal };

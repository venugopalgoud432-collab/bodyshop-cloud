const dayjs = require("dayjs");

const statusLabels = {
  ON_LOT: "On Lot",
  WIP: "WIP",
  WAITING_PARTS: "Waiting Parts",
  WAITING_APPROVAL: "Waiting Approval",
  PAINT: "Paint",
  QC: "QC",
  READY_TO_DELIVER: "Ready To Deliver",
  DELIVERED: "Delivered",
  ON_HOLD: "On Hold"
};

function statusLabel(status) {
  return statusLabels[status] || status;
}

function formatDateInput(value) {
  if (!value) return "";
  return dayjs(value).format("YYYY-MM-DD");
}

function hoursLeft(job) {
  return Math.max(Number(job.estimatedHours || 0) - Number(job.hoursWorked || 0), 0);
}

const statusOptions = Object.keys(statusLabels).map((key) => ({
  value: key,
  label: statusLabels[key]
}));

module.exports = { statusLabel, formatDateInput, hoursLeft, statusOptions };

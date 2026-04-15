const fs = require("fs");
const path = require("path");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

function getDriver() {
  return process.env.STORAGE_DRIVER || "local";
}

async function saveUploadedFile(file) {
  const driver = getDriver();

  if (driver === "s3") {
    const bucket = process.env.S3_BUCKET;
    const key = `jobs/${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

    const client = new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      credentials: process.env.S3_ACCESS_KEY_ID
        ? {
            accessKeyId: process.env.S3_ACCESS_KEY_ID,
            secretAccessKey: process.env.S3_SECRET_ACCESS_KEY
          }
        : undefined,
      forcePathStyle: !!process.env.S3_ENDPOINT
    });

    const body = fs.readFileSync(file.path);

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: file.mimetype
      })
    );

    const publicBase = process.env.PUBLIC_FILES_BASE_URL || "";
    const filePath = publicBase ? `${publicBase}/${key}` : key;

    return { filePath, storageKey: key };
  }

  return {
    filePath: `/uploads/${path.basename(file.path)}`,
    storageKey: null
  };
}

module.exports = { saveUploadedFile, getDriver };

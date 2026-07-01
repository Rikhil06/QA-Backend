const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const sharp = require('sharp');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY,
    secretAccessKey: process.env.R2_SECRET_KEY,
  },
});

const getSignedR2Url = async (key) => {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }),
    { expiresIn: 7 * 24 * 60 * 60 } // 1 WEEK
  );
};

const uploadBufferToR2 = async (buffer, key, contentType) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
};

const generateThumbnail = async (buffer) => {
  return sharp(buffer)
    .resize(300) // width 300px
    .webp({ quality: 80 })
    .toBuffer();
};

// Extract the R2 object key from a signed URL.
// Signed URLs look like: https://{account}.r2.cloudflarestorage.com/{bucket}/{key}?X-Amz-...
function keyFromSignedUrl(signedUrl) {
  try {
    const u = new URL(signedUrl);
    const bucket = process.env.R2_BUCKET_NAME;
    // pathname is /{bucket}/{key...}
    const prefix = `/${bucket}/`;
    if (!u.pathname.startsWith(prefix)) return null;
    return u.pathname.slice(prefix.length);
  } catch {
    return null;
  }
}

const deleteObjectFromR2 = async (key) => {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
    }),
  );
};

// Delete multiple objects in one API call (batches of 1000 max).
const deleteObjectsFromR2 = async (keys) => {
  if (!keys.length) return;
  const chunks = [];
  for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000));
  await Promise.all(
    chunks.map((chunk) =>
      s3.send(
        new DeleteObjectsCommand({
          Bucket: process.env.R2_BUCKET_NAME,
          Delete: { Objects: chunk.map((Key) => ({ Key })), Quiet: true },
        }),
      ),
    ),
  );
};

// Accept either a bare R2 key (new format) or a legacy pre-signed URL and
// return a fresh signed URL valid for 7 days. Returns null if input is falsy.
const refreshR2Url = async (keyOrUrl) => {
  if (!keyOrUrl) return null;
  // If it already looks like an https URL, extract the key first
  const key = keyOrUrl.startsWith('https://') ? keyFromSignedUrl(keyOrUrl) : keyOrUrl;
  if (!key) return keyOrUrl; // can't parse legacy URL — return as-is
  return getSignedR2Url(key);
};

module.exports = {
  getSignedR2Url,
  refreshR2Url,
  generateThumbnail,
  uploadBufferToR2,
  deleteObjectFromR2,
  deleteObjectsFromR2,
  keyFromSignedUrl,
};

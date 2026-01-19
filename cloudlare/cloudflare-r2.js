const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
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

module.exports = {
  getSignedR2Url,
  generateThumbnail,
  uploadBufferToR2,
};

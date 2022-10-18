import { NextApiRequest, NextApiResponse } from 'next';
import { PutObjectCommand, S3 } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getServerAuthSession } from '~/server/common/get-server-auth-session';

const upload = async (req: NextApiRequest, res: NextApiResponse) => {
  const missing = missingEnvs();
  if (missing.length > 0) {
    res.status(500).json({ error: `Next S3 Upload: Missing ENVs ${missing.join(', ')}` });
    return;
  }

  const session = await getServerAuthSession({ req, res });
  const userId = session?.user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const s3 = new S3({
    credentials: {
      accessKeyId: process.env.S3_UPLOAD_KEY as string,
      secretAccessKey: process.env.S3_UPLOAD_SECRET as string,
    },
    region: process.env.S3_UPLOAD_REGION as string,
    endpoint: process.env.S3_UPLOAD_ENDPOINT as string,
  });

  const { filename } = req.body;
  let { type } = req.body;
  if (!type || !(type in UploadType)) type = UploadType.Default;
  const bucket = process.env.S3_UPLOAD_BUCKET;
  const key = `${userId}/${type ?? UploadType.Default}/${filename}`;

  const url = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key }), {
    expiresIn: 60 * 60, // 1 hour
  });

  res.status(200).json({
    url,
    bucket,
    key,
  });
};

export default upload;

// This code checks the for missing env vars that this
// API route needs.
//
// Why does this code look like this? See this issue!
// https://github.com/ryanto/next-s3-upload/issues/50
//
const missingEnvs = (): string[] => {
  const keys = [];
  if (!process.env.S3_UPLOAD_KEY) {
    keys.push('S3_UPLOAD_KEY');
  }
  if (!process.env.S3_UPLOAD_SECRET) {
    keys.push('S3_UPLOAD_SECRET');
  }
  if (!process.env.S3_UPLOAD_REGION) {
    keys.push('S3_UPLOAD_REGION');
  }
  if (!process.env.S3_UPLOAD_ENDPOINT) {
    keys.push('S3_UPLOAD_ENDPOINT');
  }
  if (!process.env.S3_UPLOAD_BUCKET) {
    keys.push('S3_UPLOAD_BUCKET');
  }
  return keys;
};
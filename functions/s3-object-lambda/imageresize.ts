import { S3 } from '@aws-sdk/client-s3';
import fetch from 'node-fetch';
import sharp, { Sharp } from 'sharp';

interface GetObjectContext {
  inputS3Url: string;
  outputRoute: string;
  outputToken: string;
}

interface UserRequest {
  url: string;
  headers: { [key: string]: string };
}

interface S3ObjectLambdaEvent {
  getObjectContext: GetObjectContext;
  userRequest: UserRequest;
}

interface S3Params {
  S3Instence: S3;
  RequestRoute: string;
  RequestToken: string;
}

const IMAGE_EXTENSIONS = ['jpeg', 'jpg', 'png', 'gif', 'webp', 'avif'];

const responseOriginFile = async (InputS3Params: S3Params, S3Url: string) => {
  try {
    const data = await fetch(S3Url);
    const buffer = Buffer.from(await data.arrayBuffer());

    await InputS3Params.S3Instence.writeGetObjectResponse({
      Body: buffer,
      RequestRoute: InputS3Params.RequestRoute,
      RequestToken: InputS3Params.RequestToken,
    });
  } catch (err) {
    console.error('responseImage', err);
    throw new Error('Function responseImage Error');
  }
};

const responseImage = async (InputS3Params: S3Params, imageBuffer: Buffer, contentType: string) => {
  try {
    await InputS3Params.S3Instence.writeGetObjectResponse({
      Body: imageBuffer,
      RequestRoute: InputS3Params.RequestRoute,
      RequestToken: InputS3Params.RequestToken,
      ContentType: contentType,
    });
  } catch (err) {
    console.error('responseImage', err);
    throw new Error('Function responseImage Error');
  }
};

const responseError = async (InputS3Params: S3Params, code: number) =>
  await InputS3Params.S3Instence.writeGetObjectResponse({
    StatusCode: code,
    RequestRoute: InputS3Params.RequestRoute,
    RequestToken: InputS3Params.RequestToken,
  });

const resizeImage = async (S3Url: string, w: number) => {
  try {
    const data = await fetch(S3Url);
    const buffer = Buffer.from(await data.arrayBuffer());
    let s: Sharp = sharp(buffer, { animated: true });
    if (w !== 0) {
      s = s.resize({
        width: w,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const transformed: Buffer = await s.webp({ lossless: true }).toBuffer();

    return { image: transformed, format: 'webp' };
  } catch (err) {
    console.error('resizeImage', err);
    throw new Error('Function resizeImage Error');
  }
};

const checkFileExist = async (s3: S3, fileName: string) => {
  try {
    const result = await s3.headObject({
      Bucket: process.env.BUCKET_NAME,
      Key: fileName,
    });
    return Object.keys(result).length !== 0;
  } catch (err) {
    return false;
  }
};

const findResizedImage = async (s3: S3, prefix: string, w: Number) => {
  const prefixKey: string = w === 0 ? `${prefix}.webp` : `${prefix}-${w}wx`;
  try {
    const { Contents } = await s3.listObjects({
      Bucket: process.env.BUCKET_NAME,
      Prefix: prefixKey,
    });
    return Contents;
  } catch (err) {
    console.error('findResizedImage', err);
    throw new Error('Find Exist Image Error');
  }
};

const putImageToBucket = async (
  s3: S3,
  imageBuffer: Buffer,
  prefix: string,
  w: Number,
  format: string
) => {
  try {
    const s = sharp(imageBuffer, { animated: true });
    const h = Number((await s.metadata()).height);

    const forwardUri =
      w === 0 ? `${prefix}.${format}` : `${prefix}-${w || 0}wx${h || 0}h.${format}`;
    await s3.putObject({
      Body: imageBuffer,
      Bucket: process.env.BUCKET_NAME,
      ContentType: `image/${format}`,
      Key: forwardUri,
    });
  } catch (err) {
    console.error('putImageToBucket', err);
    throw new Error('Put Image To S3 Bucket Error');
  }
};

const getExistS3Object = async (s3: S3, imageKey: string) => {
  try {
    const imgObject = await s3.getObject({
      Key: imageKey,
      Bucket: process.env.BUCKET_NAME,
    });
    const stream = imgObject.Body;

    const chunks = [];
    // @ts-ignore: Unreachable code error
    for await (const chunk of stream) {
      chunks.push(chunk);
    }
    const contentBuffer: Buffer = Buffer.concat(chunks);
    return { body: contentBuffer, contentType: imgObject.ContentType };
  } catch (err) {
    console.error('getExistS3Object', err);
    throw new Error('Function getExistS3Object Error');
  }
};

exports.handler = async (event: S3ObjectLambdaEvent): Promise<void> => {
  const s3 = new S3({});
  console.log('event', event);
  const requestUrl = new URL(event.userRequest.url);
  const pathName = requestUrl.pathname;
  const prefix = pathName.split('.')[0].slice(1);
  const fileExtension = pathName.split('.')[1];
  const searchParams = requestUrl.searchParams;
  const w = searchParams.has('width') ? Number(searchParams.get('width')) : 0;
  const { inputS3Url, outputRoute, outputToken } = event.getObjectContext;
  const s3InputParams: S3Params = {
    S3Instence: s3,
    RequestRoute: outputRoute,
    RequestToken: outputToken,
  };

  try {
    const isFileExist = await checkFileExist(s3, pathName.slice(1));
    if (!isFileExist) {
      await responseError(s3InputParams, 404);
      return;
    }
    if (!IMAGE_EXTENSIONS.includes(fileExtension)) {
      await responseOriginFile(s3InputParams, inputS3Url);
      return;
    }
    const Contents = await findResizedImage(s3, prefix, w);

    if (!Contents) {
      const resizedImage = await resizeImage(inputS3Url, w);
      await putImageToBucket(s3, resizedImage.image, prefix, w, resizedImage.format);
      await responseImage(s3InputParams, resizedImage.image, resizedImage.format);
    } else {
      const thumbnail: string = Contents[0].Key ?? '';
      const existImage = await getExistS3Object(s3, thumbnail);
      await responseImage(s3InputParams, existImage.body, existImage.contentType ?? '');
    }
    return;
  } catch (e: unknown) {
    console.error('---------------------');
    console.error(JSON.stringify(e));
    console.error('---------------------');

    if (e instanceof Error) {
      await responseError(s3InputParams, 500);
      return;
    }
  }
};
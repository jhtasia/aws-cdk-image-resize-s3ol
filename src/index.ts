import { Duration, Stack, Token } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3objectlamda from 'aws-cdk-lib/aws-s3objectlambda';
import { Construct } from 'constructs';
import * as randomstring from 'randomstring';

import { S3ObjectLambdaOrigin } from './s3-object-lambda-origin';
import { DistributionProps } from './types';

export interface IImageResizeProps {
  s3Bucket?: s3.IBucket;
  s3BucketProps?: s3.BucketProps;
  cloudfrontDistributionProps?: DistributionProps;
  project: string;
  s3Prefix: string;
}

export class ImageResize extends Construct {
  distribution: cloudfront.Distribution;
  imagesBucket: s3.IBucket;
  readonly project: string;
  readonly s3Prefix: string;

  constructor(scope: Construct, id: string, props: IImageResizeProps) {
    super(scope, id);
    this.project = props.project;
    this.s3Prefix = props.s3Prefix;
    const { s3BucketProps, cloudfrontDistributionProps } = props;

    const account = Stack.of(this).account;
    const region = Stack.of(this).region;

    this.imagesBucket = props.s3Bucket ?? new s3.Bucket(this, 'Bucket', s3BucketProps);
    const s3ObjectLambdaFunc = new NodejsFunction(this, 'ImageResizeFunction', {
      runtime: lambda.Runtime.NODEJS_14_X,
      entry: `${__dirname}/functions/s3-object-lambda/imageresize.ts`,
      depsLockFilePath: `${__dirname}/functions/s3-object-lambda/yarn.lock`,
      bundling: {
        minify: true,
        nodeModules: ['sharp', 'node-fetch'],
        forceDockerBundling: true,
      },
      timeout: Duration.minutes(1),
      memorySize: 1024,
      environment: {
        BUCKET_NAME: this.imagesBucket.bucketName,
      },
    });
    this.imagesBucket.grantRead(s3ObjectLambdaFunc);
    this.imagesBucket.grantPut(s3ObjectLambdaFunc); // S3 Object Lammbda add
    this.imagesBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['*'],
        principals: [new iam.ArnPrincipal('*')],
        resources: [this.imagesBucket.bucketArn, this.imagesBucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            's3:DataAccessPointAccount': account,
          },
        },
      })
    );

    s3ObjectLambdaFunc.role?.attachInlinePolicy(
      new iam.Policy(this, 'WriteGetObjectResponsePolicy', {
        statements: [
          new iam.PolicyStatement({
            actions: [
              's3-object-lambda:WriteGetObjectResponse',
              's3-object-lambda:PutObject',
              's3-object-lambda:PutObjectAcl',
            ],
            resources: ['*'],
          }),
        ],
      })
    );

    s3ObjectLambdaFunc.addPermission('AllowCloudFrontInvoke', {
      principal: new iam.ServicePrincipal('cloudfront.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    const accessPointName = `${id}-${randomstring.generate(7)}`.toLowerCase();
    const accessPoint = new s3.CfnAccessPoint(this, 'AccessPoint', {
      name: accessPointName,
      bucket: this.imagesBucket.bucketName,
      policy: {
        Version: '2012-10-17',
        Id: 'default',
        Statement: [
          {
            Sid: 's3objlambda',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3:*',
            Resource: [
              `arn:aws:s3:${region}:${account}:accesspoint/${accessPointName}`,
              `arn:aws:s3:${region}:${account}:accesspoint/${accessPointName}/object/*`,
            ],
            Condition: {
              'ForAnyValue:StringEquals': {
                'aws:CalledVia': 's3-object-lambda.amazonaws.com',
              },
            },
          },
        ],
      },
    });

    const objectLambdaAccessPoint = new s3objectlamda.CfnAccessPoint(
      this,
      'ObjectLambdaAccessPoint',
      {
        objectLambdaConfiguration: {
          supportingAccessPoint: Token.asString(accessPoint.getAtt('Arn')),
          transformationConfigurations: [
            {
              actions: ['GetObject'],
              contentTransformation: {
                AwsLambda: {
                  FunctionArn: s3ObjectLambdaFunc.functionArn,
                },
              },
            },
          ],
        },
      }
    );

    const cloudfrontFunctionCodeOptions: cloudfront.FileCodeOptions = {
      filePath: `${__dirname}/functions/cloudfront-function/index.js`,
    };
    const cloudfrontFunction = new cloudfront.Function(this, 'cloudfrontFunction', {
      code: cloudfront.FunctionCode.fromFile(cloudfrontFunctionCodeOptions),
    });

    const cachePolicy =
      cloudfrontDistributionProps?.defaultBehavior?.cachePolicy ??
      new cloudfront.CachePolicy(this, 'CachePolicy', {
        defaultTtl: Duration.days(365), // 1 year
        enableAcceptEncodingBrotli: true,
        enableAcceptEncodingGzip: true,
        maxTtl: Duration.days(365 * 2), // 2 years
        minTtl: Duration.days(30 * 3), // 3 months
        queryStringBehavior: cloudfront.CacheQueryStringBehavior.allowList('height', 'width'),
      });

    // Cloudfront distribution for the S3 bucket.
    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      ...cloudfrontDistributionProps,
      defaultBehavior: {
        cachePolicy: cachePolicy,
        origin: new S3ObjectLambdaOrigin(
          `${Token.asString(
            objectLambdaAccessPoint.getAtt('Alias.Value')
          )}.s3.${region}.amazonaws.com`
        ),
        functionAssociations: [
          {
            function: cloudfrontFunction,
            eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          },
        ],
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        ...cloudfrontDistributionProps?.defaultBehavior,
      },
    });

    new s3objectlamda.CfnAccessPointPolicy(this, 'ObjectLambdaAccessPointPolicy', {
      objectLambdaAccessPoint: objectLambdaAccessPoint.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3-object-lambda:Get*',
            Resource: Token.asString(objectLambdaAccessPoint.getAtt('Arn')),
            Condition: {
              StringEquals: {
                'aws:SourceArn': `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
              },
            },
          },
          {
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3-object-lambda:Put*',
            Resource: Token.asString(objectLambdaAccessPoint.getAtt('Arn')),
            Condition: {
              StringEquals: {
                'aws:SourceArn': `arn:aws:cloudfront::${account}:distribution/${this.distribution.distributionId}`,
              },
            },
          },
        ],
      },
    });

    const originAccessControl = new cloudfront.CfnOriginAccessControl(this, 'OriginAccessControl', {
      originAccessControlConfig: {
        name: `${id}-${randomstring.generate(7)}`,
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    (this.distribution.node.defaultChild as cloudfront.CfnDistribution).addPropertyOverride(
      'DistributionConfig.Origins.0.OriginAccessControlId',
      originAccessControl.attrId
    );
  }
}

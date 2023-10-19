import { awscdk } from 'projen';
const project = new awscdk.AwsCdkConstructLibrary({
  author: 'Yu-Hsiang Huang',
  authorAddress: 'yhhuang79@gmail.com',
  cdkVersion: '2.44.0',
  defaultReleaseBranch: 'main',
  jsiiVersion: '~5.0.0',
  name: 'aws-cdk-image-resize-s3ol',
  projenrcTs: true,
  repositoryUrl: 'https://github.com/jhtasia/aws-cdk-image-resize-s3ol.git',
  keywords: ['aws-cdk', 'aws', 'cdk', 'cloudfront', 'formatter', 'images', 's3-object-lambda', 'cloudfront-function', 'resize'],
  gitignore: ['cdk.out'],

  // deps: [],                /* Runtime dependencies of this module. */
  // description: undefined,  /* The description is just a string that helps people understand the purpose of the package. */
  // devDeps: [],             /* Build dependencies for this module. */
  // packageName: undefined,  /* The "name" in package.json. */
});
project.synth();
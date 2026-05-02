// =============================================================================
// Canonical Template: S3 Object Trigger
// Skill: runtime-patterns-data-events
// Use Case: Process files uploaded to S3 with prefix/suffix filters
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { S3Event } from 'aws-lambda';

// Step 1: Define service classes
class ImageProcessor {
  async processImage(bucket: string, key: string, size: number): Promise<void> {
    // Implementation: download from S3, resize, generate thumbnails, upload result
  }

  async validateImage(bucket: string, key: string): Promise<boolean> {
    // Implementation: check file size, format, dimensions
    return true;
  }
}

// Step 2: Define ties type
type ImageProcessorTies = {
  imageProcessor: ImageProcessor;
};

// Step 3: Create Lambda definition with S3 integration
export const imageUploadHandler: LambdaDefinition<ImageProcessorTies, {}, 's3'> = {
  id: 'process-image-upload',
  ties: {
    imageProcessor: ImageProcessor,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as S3Event (augmented with ties and snapshot)
    // S3 can deliver MULTIPLE records in one invocation — always iterate

    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      // S3 object keys are URL-encoded: '+' represents spaces, special chars are percent-encoded
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
      const size = record.s3.object.size;
      const eventType = record.eventName;  // e.g., 'ObjectCreated:Put'

      // Validate before processing
      const isValid = await event.ties.imageProcessor.validateImage(bucket, key);

      if (isValid) {
        await event.ties.imageProcessor.processImage(bucket, key, size);
      }
    }

    // S3 trigger handlers do not return a meaningful value
  },
  s3: {
    bucket: 'uploads-bucket',           // Bucket name string or CDK IBucket construct
    events: ['s3:ObjectCreated:*'],     // S3 event types to listen for
    prefix: 'uploads/',                 // Only trigger for keys starting with 'uploads/'
    suffix: '.jpg',                     // Only trigger for .jpg files
  },
};

// Alternative: Multiple event types and no filters
export const allObjectEventsHandler: LambdaDefinition<ImageProcessorTies, {}, 's3'> = {
  id: 'process-all-objects',
  ties: { imageProcessor: ImageProcessor },
  handler: async (event, context) => {
    for (const record of event.Records) {
      const bucket = record.s3.bucket.name;
      const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));

      switch (true) {
        case record.eventName.startsWith('ObjectCreated'):
          await event.ties.imageProcessor.processImage(bucket, key, record.s3.object.size);
          break;
        case record.eventName.startsWith('ObjectRemoved'):
          // Handle deletion — clean up thumbnails, metadata, etc.
          break;
      }
    }
  },
  s3: {
    bucket: 'media-bucket',
    events: ['s3:ObjectCreated:*', 's3:ObjectRemoved:*'],
    // No prefix/suffix — triggers for all objects in the bucket
  },
};

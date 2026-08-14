terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "floci"
  secret_key                  = "floci"
  skip_credentials_validation = true
  skip_requesting_account_id  = true
  skip_metadata_api_check     = true
  skip_region_validation      = true
  s3_use_path_style           = true

  endpoints {
    s3     = "http://localhost:4566"
    sqs    = "http://localhost:4566"
    lambda = "http://localhost:4566"
    iam    = "http://localhost:4566"
  }
}

resource "random_id" "suffix" {
  byte_length = 4
}

resource "aws_s3_bucket" "storage" {
  bucket        = "floci-terraform-demo-${random_id.suffix.hex}"
  force_destroy = true
}

resource "aws_s3_bucket_versioning" "storage" {
  bucket = aws_s3_bucket.storage.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_sqs_queue" "work" {
  name                       = "floci-terraform-queue"
  visibility_timeout_seconds = 30
}

output "bucket_name" {
  value = aws_s3_bucket.storage.bucket
}

output "queue_url" {
  value = aws_sqs_queue.work.url
}

import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyDirectory, ensureDirectory, pathExists, writeJson } from "./fs-utils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { version: frameworkVersion } = require("../package.json");
const TEMPLATE_ROOT = path.resolve(__dirname, "../templates/default");

async function writeSitePackageJson(targetDirectory, siteName) {
  const packageJsonPath = path.join(targetDirectory, "package.json");
  const packageJson = {
    name: siteName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "evolit dev",
      build: "evolit build",
      start: "evolit start",
      typecheck: "litsx-tsc -p jsconfig.json --noEmit",
    },
    dependencies: {
      "@litsx/core": "0.17.0-canary-feat-ssr-20260726130435",
      evolit: frameworkVersion,
    },
    devDependencies: {
      "@litsx/typescript": "^0.9.0",
      "typescript": "^6.0.0",
    },
  };

  await writeJson(packageJsonPath, packageJson);
}

export async function scaffoldSite(targetDirectory, options = {}) {
  const absoluteTargetDirectory = path.resolve(targetDirectory);
  const siteName = options.name ?? path.basename(absoluteTargetDirectory);

  if (await pathExists(absoluteTargetDirectory)) {
    const entries = await fs.readdir(absoluteTargetDirectory);
    if (entries.length > 0) {
      throw new Error(`Target directory is not empty: ${absoluteTargetDirectory}`);
    }
  } else {
    await ensureDirectory(absoluteTargetDirectory);
  }

  await copyDirectory(TEMPLATE_ROOT, absoluteTargetDirectory);
  await writeSitePackageJson(absoluteTargetDirectory, siteName);
  await fs.writeFile(
    path.join(absoluteTargetDirectory, "evolit.config.js"),
    [
      "export default {",
      "  // Reserved for framework configuration.",
      "  // Response cache adapters and deployment-specific runtime hooks can live here.",
      "  // Example for object storage adapters such as S3:",
      "  // import { ObjectStorageResponseCacheStore } from \"evolit\";",
      "  // import {",
      "  //   DeleteObjectCommand,",
      "  //   GetObjectCommand,",
      "  //   PutObjectCommand,",
      "  //   S3Client,",
      "  // } from \"@aws-sdk/client-s3\";",
      "  //",
      "  // const s3 = new S3Client({ region: process.env.AWS_REGION });",
      "  // const bucket = process.env.EVOLIT_CACHE_BUCKET;",
      "  // responseCache: {",
      "  //   async createStore() {",
      "  //     return new ObjectStorageResponseCacheStore({",
      "  //       prefix: \"routes\",",
      "  //       async getObject(key) {",
      "  //         try {",
      "  //           const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));",
      "  //           return await result.Body.transformToString();",
      "  //         } catch (error) {",
      "  //           if (error?.name === \"NoSuchKey\") return null;",
      "  //           throw error;",
      "  //         }",
      "  //       },",
      "  //       async putObject(key, value) {",
      "  //         await s3.send(new PutObjectCommand({",
      "  //           Bucket: bucket,",
      "  //           Key: key,",
      "  //           Body: value,",
      "  //           ContentType: \"application/json; charset=utf-8\",",
      "  //         }));",
      "  //       },",
      "  //       async deleteObject(key) {",
      "  //         await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));",
      "  //       },",
      "  //     });",
      "  //   },",
      "  //   createKey({ request }) {",
      "  //     return new URL(request.url).pathname;",
      "  //   },",
      "  // },",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  return absoluteTargetDirectory;
}

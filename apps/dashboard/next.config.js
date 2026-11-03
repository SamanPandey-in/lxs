const path = require("node:path");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // standalone project inside a pnpm monorepo: pin the tracing root to this folder
  outputFileTracingRoot: path.join(__dirname),
};
module.exports = nextConfig;

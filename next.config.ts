import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Next 16's CLI runner cannot parse otherwise-valid pnpm TypeScript output in this image.
    useTypeScriptCli: false,
  },
};

export default nextConfig;

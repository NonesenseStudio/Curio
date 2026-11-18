/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  experimental: {
    // jsdom must not be bundled; it resolves internal modules dynamically.
    serverComponentsExternalPackages: ["jsdom"],
  },
};
export default nextConfig;

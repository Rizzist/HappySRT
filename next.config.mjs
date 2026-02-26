import nextPWA from "next-pwa";

const withPWA = nextPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",
  cacheStartUrl: false,
  dynamicStartUrl: true,
  register: true,
  skipWaiting: true,
});

export default withPWA({
  reactCompiler: true,
  reactStrictMode: true,

  async headers() {
    return [
      {
        source: "/.well-known/assetlinks.json",
        headers: [
          {
            key: "Content-Type",
            value: "application/json; charset=utf-8",
          },
        ],
      },

      // If you also use iOS universal links, do the same for AASA:
      {
        source: "/.well-known/apple-app-site-association",
        headers: [
          {
            key: "Content-Type",
            value: "application/json; charset=utf-8",
          },
        ],
      },
    ];
  },
});
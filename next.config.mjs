import nextPWA from "next-pwa";

const withPWA = nextPWA({
  dest: "public",
  disable: process.env.NODE_ENV === "development",

  // Your home page changes based on auth state (anon vs logged-in),
  // so it’s often safer NOT to precache "/":
  cacheStartUrl: false,
  dynamicStartUrl: true,

  register: true,
  skipWaiting: true,
});

export default withPWA({
  reactCompiler: true,
  reactStrictMode: true,
});

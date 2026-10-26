import fs from "node:fs";
import path from "node:path";
import type { NextConfig } from "next";

// The WalletConnect (Reown) project id is public (it ends up in the page), and it is kept in the project's .env next to the
// other settings. Next.js only reads .env files inside web/, so this copies THAT ONE value from ../.env (or ../.env.local).
// Nothing else in those files is read, and nothing secret is ever put into the page.
function walletConnectProjectId(): string | undefined {
  if (process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID;
  for (const file of [".env.local", ".env"]) {
    try {
      const text = fs.readFileSync(path.resolve(import.meta.dirname, "..", file), "utf8");
      const line = text.split(/\r?\n/).find((l) => /^\s*(NEXT_PUBLIC_)?(WALLETCONNECT|REOWN)_PROJECT_ID\s*=/.test(l));
      const value = line?.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
      if (value) return value;
    } catch {
      // no such file: try the next one
    }
  }
  return undefined;
}

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  env: { NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: walletConnectProjectId() ?? "" },
  turbopack: {
    // The web folder lives inside the contracts project, which has its own package-lock.json: pin the root here.
    root: path.resolve(import.meta.dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

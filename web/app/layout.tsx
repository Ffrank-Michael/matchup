import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const SITE = "https://www.playmatchup.xyz";
const TITLE = "Matchup | Prediction market for AI agents";
const DESCRIPTION = "The prediction market where AI agents compete. Call BTC, ETH and SOL, or back an agent.";

export const metadata: Metadata = {
  // Link previews (og:image / twitter:image from app/opengraph-image.png and app/twitter-image.png) need an absolute address.
  // The public address is www.playmatchup.xyz, so the previews always point at it.
  metadataBase: new URL(process.env.VERCEL_PROJECT_PRODUCTION_URL ? SITE : "http://localhost:3000"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Matchup",
  openGraph: { type: "website", url: SITE, siteName: "Matchup", title: TITLE, description: DESCRIPTION },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}

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
const OG_IMAGE = "/brand/og-image.png"; // 1200 x 630, used for Open Graph and the Twitter card
const DESCRIPTION = "The prediction market where AI agents compete. Call BTC, ETH and SOL up or down, or back an agent.";

export const metadata: Metadata = {
  // Link previews (og:image / twitter:image) need an absolute address.
  // The public address is www.playmatchup.xyz, so the previews always point at it.
  metadataBase: new URL(process.env.VERCEL_PROJECT_PRODUCTION_URL ? SITE : "http://localhost:3000"),
  title: TITLE,
  description: DESCRIPTION,
  applicationName: "Matchup",
  openGraph: { type: "website", url: SITE, siteName: "Matchup", title: TITLE, description: DESCRIPTION, images: [{ url: OG_IMAGE, width: 1200, height: 630, alt: DESCRIPTION }] },
  twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION, images: [OG_IMAGE] },
  icons: {
    icon: [
      { url: "/brand/matchup-icon-square.svg", type: "image/svg+xml" },
      { url: "/brand/icon-512.png", type: "image/png", sizes: "512x512" },
    ],
    apple: { url: "/brand/apple-icon.png", sizes: "180x180" },
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

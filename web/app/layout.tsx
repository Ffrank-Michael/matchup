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

export const metadata: Metadata = {
  // Link previews (og:image / twitter:image from app/opengraph-image.png and app/twitter-image.png) need an absolute address.
  // The public address is www.kairomarkets.xyz; kairomarkets.vercel.app serves the same site, so the previews always point at the public one.
  metadataBase: new URL(process.env.VERCEL_PROJECT_PRODUCTION_URL ? "https://www.kairomarkets.xyz" : "http://localhost:3000"),
  title: "Kairo Markets",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
  description: "Call the next move. Back an agent. UP or DOWN on BTC, ETH and SOL, in USDC on Arc.",
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

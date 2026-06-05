import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "WebLink Share - High-Speed Direct P2P File Sharing",
  description: "Share large files directly peer-to-peer over your local network or internet with super ultra-high speed using WebRTC and no file size limits.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
        <div className="orb-right"></div>
      </body>
    </html>
  );
}

import type { Metadata } from "next";

import "./styles.css";

export const metadata: Metadata = {
  title: "ReStar",
  description: "Turn GitHub Stars into an active memory system.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

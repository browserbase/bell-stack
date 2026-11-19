import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Bell | Your personal assistant",
  description: "A small, independent browser assistant.",
  icons: { icon: "/bell.png" },
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

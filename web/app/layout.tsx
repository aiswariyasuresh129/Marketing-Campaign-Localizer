import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Campaign Localizer",
  description: "Upload campaign assets, follow the review, and see what needs approval.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="en"><body>{children}</body></html>;
}

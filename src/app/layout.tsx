import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PeakCut — Extraction éditoriale de moments forts",
  description:
    "PeakCut aide un monteur humain à repérer, éditer et exporter des extraits courts à partir d'une vidéo, avec score explicable et validation humaine obligatoire.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="fr" className="h-full antialiased">
      <body className="min-h-full flex flex-col bg-zinc-950 text-zinc-100">{children}</body>
    </html>
  );
}

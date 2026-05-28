import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "StyleClone Demo — Clone Any Video's Editing Style",
  description:
    "Upload a reference video, your footage, and B-roll. StyleClone analyzes the editing style and recreates it with your content in seconds.",
  openGraph: {
    title: "StyleClone Demo",
    description: "AI-powered video style cloning. Upload 3 videos, get a styled edit back.",
    type: "website",
  },
};

export default function DemoLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}

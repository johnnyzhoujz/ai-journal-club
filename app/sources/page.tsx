"use client";
import { SourceTabs } from "@/components/source-tabs";

export default function SourcesPage() {
  return (
    <main className="w-full mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">Sources</h1>
      <SourceTabs />
    </main>
  );
}

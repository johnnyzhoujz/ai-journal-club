"use client";
import { useState } from "react";
import { useSources } from "@/hooks/use-sources";
import { SourceList } from "./source-list";
import { AddSourceForm } from "./add-source-form";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import type { SourceType } from "@/lib/schema";

const TAB_KEYS: { key: SourceType; label: string }[] = [
  { key: "x_account", label: "X Accounts" },
  { key: "podcast", label: "Podcasts" },
  { key: "newsletter", label: "Newsletters" },
  { key: "papers", label: "Papers" },
];

export function SourceTabs() {
  const [activeTab, setActiveTab] = useState<SourceType>("x_account");
  const { data, loading, error, addSource, removeSource, togglePapers } = useSources();
  const [toggling, setToggling] = useState(false);

  if (loading) {
    return <p className="text-muted-foreground text-sm py-8 text-center">Loading sources...</p>;
  }

  function sourcesForTab() {
    if (!data) return [];
    switch (activeTab) {
      case "x_account": return data.x_accounts;
      case "podcast": return data.podcasts;
      case "newsletter": return data.newsletters;
      default: return [];
    }
  }

  async function handleTogglePapers() {
    setToggling(true);
    try {
      await togglePapers();
    } finally {
      setToggling(false);
    }
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={(value) => setActiveTab(value as SourceType)}
      className="w-full"
    >
      <TabsList variant="line" className="w-full justify-start mb-6">
        {TAB_KEYS.map((tab) => (
          <TabsTrigger key={tab.key} value={tab.key}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>

      {error && (
        <p className="text-destructive text-sm mb-4">{error}</p>
      )}

      {TAB_KEYS.filter((t) => t.key !== "papers").map((tab) => (
        <TabsContent key={tab.key} value={tab.key}>
          <AddSourceForm type={tab.key} onAdd={addSource} />
          <SourceList sources={tab.key === activeTab ? sourcesForTab() : []} onRemove={removeSource} type={tab.key} />
        </TabsContent>
      ))}

      <TabsContent value="papers">
        <div className="flex items-center justify-between gap-8 rounded-lg border border-border p-6">
          <div className="space-y-1">
            <Label htmlFor="papers-toggle" className="text-sm font-medium">
              Hugging Face Daily Papers
            </Label>
            <p className="text-muted-foreground text-sm">
              Automatically fetch top papers from Hugging Face daily
            </p>
          </div>
          <Switch
            id="papers-toggle"
            checked={data?.papers.enabled ?? false}
            onCheckedChange={handleTogglePapers}
            disabled={toggling}
          />
        </div>
      </TabsContent>
    </Tabs>
  );
}
